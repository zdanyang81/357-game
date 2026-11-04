'use strict';
// Local Canvas preview only. Not a replacement for WeChat developer-tool testing.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const modules = ['core/engine', 'ui'];
const wrappers = modules.map(name => `${JSON.stringify(name)}:function(module,exports,require){\n${fs.readFileSync(path.join(root, 'minigame', name + '.js'), 'utf8')}\n}`).join(',\n');
const width = Number(process.argv[2] || 375);
const height = Number(process.argv[3] || 812);
const scene = process.argv[4] || 'home';
const safeTop = Number(process.argv[5] || 84);
const safeBottom = Number(process.argv[6] || 34);
if (!Number.isFinite(safeTop) || !Number.isFinite(safeBottom) || safeTop < 0 || safeBottom < 0 || safeTop + safeBottom > height / 2) throw Error('Invalid safe area');
if (!Number.isInteger(width) || !Number.isInteger(height) || width < 280 || height < 480 || width > 1600 || height > 2400) throw Error('Invalid preview dimensions');
const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>357 Canvas development preview</title><style>html,body{margin:0;background:#0b211b}canvas{display:block;touch-action:none}</style><canvas id="game"></canvas><script>
const modules={${wrappers}};const cache={};function require(name){name=name.replace(/^\\.\\//,'');if(cache[name])return cache[name].exports;const module={exports:{}};cache[name]=module;modules[name](module,module.exports,require);return module.exports;}
const canvas=document.getElementById('game');canvas.width=${width};canvas.height=${height};const memory={};
const platform={canvas,width:${width},height:${height},dpr:1,safeTop:${safeTop},safeBottom:${safeBottom},storage:{get:k=>memory[k],set:(k,v)=>{memory[k]=v;return true;}},sound(){},vibrate(){},share(){},createCanvas:()=>document.createElement('canvas'),requestAnimationFrame:fn=>requestAnimationFrame(fn),cancelAnimationFrame:id=>cancelAnimationFrame(id),now:()=>performance.now(),onTouchStart(fn){canvas.addEventListener('pointerdown',e=>{const r=canvas.getBoundingClientRect();fn({x:e.clientX-r.left,y:e.clientY-r.top});});},onTouchCancel(fn){canvas.addEventListener('pointercancel',()=>fn());},onTouch(fn){canvas.addEventListener('pointerup',e=>{const r=canvas.getBoundingClientRect();fn({x:e.clientX-r.left,y:e.clientY-r.top});});},onHide(fn){document.addEventListener('visibilitychange',()=>{if(document.hidden)fn();});},onShow(fn){document.addEventListener('visibilitychange',()=>{if(!document.hidden)fn();});},setTimeout,clearTimeout};
window.ui=new (require('ui'))(platform);window.previewScene=${JSON.stringify(scene)};
if(window.previewScene!=='home'){ui.startGame({mode:'pvp',difficulty:'hard',aiFirst:false,avatars:[0,3]});if(window.previewScene==='rules'){ui.openModal('rules');}if(window.previewScene==='result'){const engine=require('core/engine');while(ui.state.winner===null){const row=ui.state.piles.findIndex(n=>n>0);ui.state=engine.move(ui.state,row,1);}ui.finish();}}
</script></html>`;
const out = path.join(root, 'artifacts', `preview-${width}x${height}-${scene}.html`);
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, html); console.log(out);
