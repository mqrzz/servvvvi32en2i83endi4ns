// Шаблоны страниц «Узла»: у каждого свои раскладка, соцсети, плеер, аватарка и «Обо мне». Подключается из uzel.js.
const crypto = require('crypto');

const BGS = ['none', 'night', 'chrome', 'chrome2', 'sky', 'rose', 'planet', 'statue', 'polaroid', 'ocean', 'room', 'forest', 'orbit', 'clouds', 'dusk', 'xp', 'paper'];
// bg: фон по умолчанию; lay: раскладка шапки; s: соцсети (round|tile|plain|out|xp); p: плеер (glass|wave|pill|min);
// a: «Обо мне» (card|arrow|text|line); light: светлый; flt: фильтр фона; spk: искры [x,y,размер]; прочее — мелкие детали
const TPL = {
  glass:    { bg: 'night',    lay: 'center', s: 'tile',  p: 'wave',  a: 'card',  pin: 1, thk: 'pill', spk: [[84, 1.5, 30], [5, 45, 16], [92, 58, 14]] },
  night:    { bg: 'night',    lay: 'giant',  s: 'round', p: 'glass', a: 'card',  glb: 1, spk: [[84, 2, 30], [5, 92, 18]] },
  silver:   { bg: 'chrome2',  lay: 'left',   s: 'tile',  p: 'glass', a: 'arrow', light: 1, flt: 'invert(1) contrast(.85) brightness(1.05)', photo: 1, bar: 1, spk: [[88, 3, 26]] },
  rose:     { bg: 'rose',     lay: 'row',    s: 'sq',  p: 'wave',  a: 'card',  badge: 1, thk: 'script', spk: [[88, 46, 42], [4, 74, 22]] },
  scrap:    { bg: 'polaroid', lay: 'scrap',  s: 'round', p: 'min',   a: 'text',  thk: 'script', spk: [[88, 62, 20], [6, 38, 24]] },
  moon:     { bg: 'ocean',    lay: 'serif',  s: 'tile',  p: 'pill',  a: 'text',  scroll: 1, spk: [[8, 4, 22]] },
  smoke:    { bg: 'chrome2',  lay: 'left',   s: 'out',   p: 'wave',  a: 'text',  menu: 1, spk: [[84, 14, 30], [6, 60, 16]] },
  chrome:   { bg: 'chrome',   lay: 'center', s: 'tile',  p: 'glass', a: 'arrow', od: 1, scroll: 1, spk: [[10, 4, 40], [88, 6, 24]] },
  mono:     { bg: 'paper',    lay: 'mono',   s: 'plain', p: 'min',   a: 'line',  light: 1, bar: 1, caps: 1, thk: 'mini', spk: [] },
  earth:    { bg: 'planet',   lay: 'center', s: 'tile',  p: 'wave',  a: 'card',  glb: 1, scroll: 1, ul: 1, spk: [] },
  graffiti: { bg: 'room',     lay: 'script', s: 'sq',  p: 'glass', a: 'text',  mono: 1, spk: [] },
  statue:   { bg: 'statue',   lay: 'serif2', s: 'plain', p: 'glass', a: 'line',  spk: [] },
  sky:      { bg: 'clouds',   lay: 'center', s: 'tile',  p: 'glass', a: 'card',  orbit: 1, spk: [[84, 4, 26]] },
  bigtype:  { bg: 'paper',    lay: 'gianto', s: 'plain', p: 'pill',  a: 'text',  light: 1, big: 1, thk: 'italic', spk: [[6, 2, 24], [90, 55, 20]] },
  forest:   { bg: 'forest',   lay: 'center', s: 'round', p: 'glass', a: 'quote', moon: 1, first: 'soc', spk: [] },
  lilac:    { bg: 'dusk',     lay: 'center', s: 'tile',  p: 'glass', a: 'card',  int: 1, thk: 'script', spk: [[86, 52, 40], [5, 80, 16]] },
  xp:       { bg: 'xp',       lay: 'xp',     s: 'xp',    p: 'glass', a: 'card',  light: 1, spk: [] },
};
const STYLES = ['classic'].concat(Object.keys(TPL));
const STYLE_BG = Object.fromEntries(Object.entries(TPL).map(([k, v]) => [k, v.bg]));

const PLAYER_JS = "(function(){var a=null,c=null;document.addEventListener('click',function(e){var b=e.target.closest('button.pl');if(!b)return;if(!a){a=new Audio();a.addEventListener('timeupdate',function(){if(c){var p=c.parentNode.querySelector('.pb b');if(p&&a.duration)p.style.width=(a.currentTime/a.duration*100)+'%'}});a.addEventListener('ended',function(){if(c)c.classList.remove('on')})}if(c===b&&!a.paused){a.pause();b.classList.remove('on');return}if(c&&c!==b)c.classList.remove('on');if(c!==b){a.src=b.getAttribute('data-src');c=b}a.play();b.classList.add('on')})})();";
const PLAYER_HASH = 'sha256-' + crypto.createHash('sha256').update(PLAYER_JS).digest('base64');

const FF = (BASE) => {
  const f = (fam, w, file, st) => ['cyrillic', 'latin'].map((s) => `@font-face{font-family:${fam};${st ? 'font-style:' + st + ';' : ''}font-weight:${w};src:url(${BASE}/assets/fonts/${file}-${s}-${w === '400 700' ? 600 : w}-${st === 'italic' ? 'italic' : 'normal'}.woff2) format("woff2");unicode-range:${s === 'cyrillic' ? 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116' : 'U+0000-00FF,U+0131,U+2000-206F,U+20AC,U+2122,U+2212'}}`).join('');
  return f('Unbounded', 800, 'unbounded') + f('"Golos Text"', '400 700', 'golos-text') + f('Oswald', 700, 'oswald') + f('"Playfair Display"', 400, 'playfair-display') + f('"Playfair Display"', 400, 'playfair-display', 'italic') + f('Caveat', 700, 'caveat');
};

const CSS = (BASE) => FF(BASE) + `
*{box-sizing:border-box}html{min-height:100%;background:#050507}
body.x{margin:0;min-height:100svh;font:16px/1.4 "Golos Text",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:var(--tx)}
.x{--tx:#fff;--mu:#ffffffb0;--gl:linear-gradient(150deg,#ffffff17,#ffffff07);--gb:#ffffff1f;--sh:inset 0 1px 0 #ffffff22,0 12px 32px #0000005c;--tile:#00000047;--ic:#fff;--pb:#ffffff1a;--pt:#fff;--ac:#fff;--ov:linear-gradient(#0000 40%,#0006);--bl:26px;--wc:#ffffffa6}
.bgl{position:fixed;inset:0;z-index:-1;background:#07070b var(--bgi,none) center top/cover no-repeat;filter:var(--flt,none)}.bgl::after{content:"";position:absolute;inset:0;background:var(--ov)}
.xw{width:min(460px,100%);margin:0 auto;padding:max(26px,env(safe-area-inset-top)) 18px 34px;display:flex;flex-direction:column;gap:14px;min-height:100svh;position:relative}
.xw>*{position:relative;z-index:1}.xw>.spk{position:absolute;z-index:0}
.glass,.xw .lk a,.xw .ct a,.xw .fm{background:var(--gl);border:1px solid var(--gb);box-shadow:var(--sh);-webkit-backdrop-filter:blur(var(--bl)) saturate(150%);backdrop-filter:blur(var(--bl)) saturate(150%)}
.spk{width:var(--z,24px);height:var(--z,24px);color:#fff;opacity:.9;filter:drop-shadow(0 0 7px #ffffff88);pointer-events:none}
/* шапка */
.xh{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:6px;position:relative;flex:1 0 auto}
.xav{width:112px;height:112px;border-radius:34px;overflow:hidden;display:grid;place-items:center;font:800 36px Unbounded,sans-serif;color:#fff;letter-spacing:-.05em;border:1px solid #ffffff40;box-shadow:0 18px 40px #0007;position:relative;flex:none}.xav img{width:100%;height:100%;object-fit:cover;display:block}
.od{position:absolute;right:8px;top:8px;width:13px;height:13px;border-radius:50%;background:#34d399;border:2px solid #0a0a0e;box-shadow:0 0 10px #34d399}
.xid{width:100%;min-width:0}.xhi{display:none;margin:0;color:var(--mu);font-size:16px;font-weight:500}.has-hello .xhi{display:block}
.xh h1{margin:8px 0 0;font:700 clamp(30px,9vw,38px)/1.05 "Golos Text",sans-serif;letter-spacing:-.03em;display:flex;align-items:center;justify-content:center;gap:10px;overflow-wrap:anywhere}.xh h1 svg{width:.55em;height:.55em;flex:none}
.xsub{margin:0;color:var(--mu);font-weight:500;font-size:17px;overflow-wrap:anywhere}
.xon{display:inline-flex;align-items:center;gap:8px;font-size:15px;color:var(--mu);font-weight:600;margin-top:4px}.xon i{width:9px;height:9px;border-radius:50%;background:#34d399;box-shadow:0 0 10px #34d399}
.xloc{display:inline-block;margin-top:8px;padding:7px 14px;border-radius:999px;background:#0000004d;border:1px solid #ffffff2b;font-size:13px;font-weight:600;color:#fff;white-space:nowrap;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
/* плееры */
.mu{display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:28px}
.cv{width:58px;height:58px;border-radius:16px;flex:none;overflow:hidden;background:#ffffff1f;display:grid;place-items:center;color:var(--mu)}.cv img{width:100%;height:100%;object-fit:cover}.cv svg{width:24px;height:24px}
.mt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.mt b{font-size:16px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt span{color:var(--mu);font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb{display:block;height:3px;border-radius:2px;background:#ffffff2e;margin-top:8px;overflow:hidden}.pb b{display:block;height:100%;width:0;background:var(--tx);border-radius:2px}
.wv{display:none;width:100%;height:24px;margin-top:8px;color:var(--wc)}.wv rect{fill:currentColor}.p-wave .wv,.p-pill .wv{display:block}.p-wave .pb,.p-pill .pb{margin-top:4px;height:2px}
.pl{width:48px;height:48px;border-radius:50%;border:1px solid #ffffff30;background:var(--pb);color:var(--pt);display:grid;place-items:center;flex:none;cursor:pointer;text-decoration:none;padding:0}.pl svg{width:20px;height:20px;fill:currentColor;stroke:none}.pl .i2{display:none}.pl.on .i1{display:none}.pl.on .i2{display:block}
.p-pill{border-radius:999px;padding:9px 10px 9px 12px;background:#000000a8}.p-pill .cv{width:46px;height:46px;border-radius:50%}
.p-min{background:none!important;border:0!important;box-shadow:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;padding:4px 0}.p-min .cv{width:52px;height:52px;border-radius:12px}
/* соцсети */
.soc{display:flex;gap:10px;justify-content:center}.soc a{display:grid;place-items:center;color:var(--ic);transition:transform .2s}.soc a:hover{transform:translateY(-2px)}.soc svg{width:25px;height:25px}
.s-tile{padding:12px;border-radius:28px;background:var(--gl);border:1px solid var(--gb);box-shadow:var(--sh);-webkit-backdrop-filter:blur(var(--bl)) saturate(150%);backdrop-filter:blur(var(--bl)) saturate(150%)}.s-tile a{flex:1 1 0;max-width:68px;height:60px;border-radius:20px;background:var(--tile);box-shadow:inset 0 1px 0 #ffffff1f}
.s-round{justify-content:space-between;padding:0 4px}.s-round a{width:58px;height:58px;border-radius:50%;background:linear-gradient(150deg,#ffffff24,#ffffff0a);border:1px solid #ffffff26;box-shadow:inset 0 1px 0 #ffffff2e,0 8px 22px #0005;-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)}
.s-plain{justify-content:space-between;padding:6px 10px}.s-plain svg{width:30px;height:30px}
.s-sq{justify-content:space-between}.s-sq a{width:58px;height:58px;border-radius:18px;background:var(--gl);border:1px solid var(--gb);box-shadow:var(--sh);-webkit-backdrop-filter:blur(var(--bl));backdrop-filter:blur(var(--bl))}
.s-out{justify-content:space-between}.s-out a{width:58px;height:58px;border-radius:18px;background:#0000008c;border:1px solid #ffffff3a;box-shadow:inset 0 0 0 1px #00000066}
.s-xp{padding:14px;background:linear-gradient(#f4f7ffeb,#dfe8f9e6);border:1px solid #2b4a9a}.s-xp a{flex:1;max-width:68px;height:60px;background:#fff;border:1px solid #2b4a9a}
/* обо мне / интересы / прочее */
.ab{padding:18px 20px;border-radius:28px}.ab h2,.xit h2,.fm h2{margin:0 0 8px;font:700 19px "Golos Text",sans-serif;display:flex;align-items:center;gap:8px}.ab h2 svg,.xit h2 svg{width:16px;height:16px;opacity:.85;flex:none}.ab p{margin:0;color:var(--mu);font-size:16px;white-space:pre-line;overflow-wrap:anywhere}
.a-arrow h2{justify-content:space-between}.a-arrow h2 .ar{width:20px;height:20px}.a-text{background:none!important;border:0!important;box-shadow:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;padding:6px 2px}.a-text h2{font-size:17px;text-decoration:underline;text-underline-offset:5px;text-decoration-thickness:1px}
.a-line{background:none!important;border:0!important;box-shadow:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;border-left:1px solid var(--tx)!important;border-radius:0;padding:4px 0 4px 16px}.a-quote{background:none!important;border:0!important;box-shadow:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;text-align:center}.a-quote p{font:italic 400 19px "Playfair Display",serif;color:var(--tx)}.a-quote h2{display:none}
.xit{padding:18px 20px;border-radius:28px}.xit h2:has(.ar){justify-content:space-between}.chips{display:flex;flex-wrap:wrap;gap:8px}.chips span{padding:8px 15px;border-radius:999px;background:var(--tile);border:1px solid var(--gb);font-size:14.5px;font-weight:600}
.glb{position:absolute;right:6px;bottom:4px;width:120px;height:120px;opacity:.55;pointer-events:none;color:#fff}
.ct{display:flex;flex-wrap:wrap;gap:10px}.ct a{display:flex;align-items:center;gap:8px;height:48px;padding:0 18px;border-radius:999px;color:var(--tx);text-decoration:none;font-weight:600;font-size:15px}.ct svg{width:18px;height:18px}
.lk{display:flex;flex-direction:column;gap:10px}.lk a{min-height:60px;border-radius:22px;display:flex;align-items:center;gap:14px;padding:0 18px;color:var(--tx);text-decoration:none;font-weight:600;font-size:16.5px;text-align:left;transition:transform .2s}.lk a:hover{transform:translateY(-2px)}.lk a span{flex:1;overflow:hidden;text-overflow:ellipsis;overflow-wrap:anywhere}.lk svg{width:21px;height:21px;flex:none}.lk .ar{opacity:.55;width:19px}.lk small{display:block;font-weight:500;font-size:13px;opacity:.7;margin-top:2px;white-space:normal}
.lk .hd{font:700 13px "Golos Text",sans-serif;letter-spacing:.14em;text-transform:uppercase;opacity:.65;margin:10px 2px -2px;text-align:left}
.fm{display:flex;flex-direction:column;gap:10px;padding:18px;border-radius:26px;text-align:left}.fm input,.fm textarea{width:100%;border:1px solid var(--gb);border-radius:16px;padding:14px 16px;font:600 16px "Golos Text",system-ui,sans-serif;color:var(--tx);background:#00000030;outline:0}.fm input::placeholder,.fm textarea::placeholder{color:var(--mu)}.fm button{min-height:52px;border:0;border-radius:18px;background:var(--tx);color:var(--bk,#0b0b0d);font:700 16px "Golos Text",sans-serif;cursor:pointer}.fm .hd{margin:0}
.xth{margin:8px 0 0;text-align:center;color:var(--mu);font-weight:600}.xth.script{font:700 30px/1 Caveat,cursive;color:var(--ac);transform:rotate(-4deg);text-align:right}.xth.pill{padding:14px;border-radius:999px;background:var(--gl);border:1px solid var(--gb)}.xth.italic{font:italic 400 19px "Playfair Display",serif;text-align:left;color:var(--tx)}.xth.mini{font-size:13px;text-align:right}
.xsc{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:13px;letter-spacing:.06em;color:var(--mu)}.xsc svg{width:18px;height:18px;transform:rotate(90deg)}
.bar{width:130px;height:40px;background:repeating-linear-gradient(90deg,var(--tx) 0 2px,#0000 2px 4px,var(--tx) 4px 5px,#0000 5px 9px,var(--tx) 9px 12px,#0000 12px 14px,var(--tx) 14px 15px,#0000 15px 19px);opacity:.85}
.xft{margin:6px 0 0;display:flex;gap:18px;justify-content:center;font-size:13.5px;color:var(--mu)}.xft a{color:inherit}
/* ====== шаблоны ====== */
/* glass: ночь, по центру */
.t-glass .xh{padding-top:46px}.t-glass .xloc{position:absolute;right:0;top:0;margin:0}
/* night: огромное имя, круглые соцсети */
.t-night .xh{align-items:flex-start;text-align:left;min-height:420px;justify-content:flex-start}.t-night .xh h1{position:absolute;left:-6px;top:58px;margin:0;font:700 var(--nf,170px)/.86 "Golos Text",sans-serif;letter-spacing:-.06em;background:linear-gradient(#ffffffd9,#ffffff40 88%);-webkit-background-clip:text;background-clip:text;color:transparent;display:block;white-space:nowrap}.t-night .xh h1 svg{display:none}
.t-night .xid{position:static;width:auto}.t-night .xsub{position:absolute;left:0;top:6px;font-size:14px;max-width:150px;z-index:2}.t-night .xav{position:absolute;right:6px;bottom:0;width:150px;height:200px;border-radius:70px 70px 26px 26px;border:0;box-shadow:0 20px 50px #0009}.t-night .xloc{position:absolute;left:0;bottom:6px;margin:0}
/* silver: светлый хром, фото-карточка */
.t-silver{--tx:#111113;--mu:#4a4a52;--gl:linear-gradient(#ffffffcc,#ffffff80);--gb:#fff;--sh:0 14px 30px #1a1a2020;--tile:#ffffffd0;--ic:#111;--pb:#111113;--pt:#fff;--ac:#111;--ov:none;--wc:#111;--bk:#fff}
.t-silver .xh{align-items:flex-start;text-align:left;gap:2px}.t-silver .xh h1{font:700 clamp(44px,14vw,60px)/1 "Golos Text",sans-serif;justify-content:flex-start;letter-spacing:-.045em}.t-silver .xsub{font-size:18px}
.t-silver .xav{width:100%;height:190px;border-radius:26px;order:5;margin-top:10px;border:0;box-shadow:0 14px 30px #0003}.t-silver .xloc{background:#ffffffb3;color:#111;border-color:#fff}
.t-silver .pl{border:0}
/* rose: неон-розы */
.t-rose{--ac:#a78bfa;--gl:linear-gradient(150deg,#8b5cf633,#14062e88);--gb:#a78bfa55;--tile:#8b5cf61f;--ic:#c4b5fd;--pb:#14062e;--pt:#c4b5fd;--sh:inset 0 1px 0 #c4b5fd33,0 0 28px #8b5cf633;--tx:#f3ecff;--mu:#c9b8f0cc;--wc:#a78bfa}
.t-rose .xh{flex-direction:row;align-items:flex-end;justify-content:flex-start;text-align:left;gap:18px;flex-wrap:wrap;min-height:380px;padding-top:30px}.t-rose .moon{position:absolute;right:0;top:0;width:26px;height:26px;color:#c4b5fd}.t-rose .hb{flex-basis:100%;margin:0 0 6px;font:500 30px/1.15 "Golos Text",sans-serif;color:#fff}.t-rose .hb b{color:#a78bfa;font-weight:600}.t-rose .xhi{display:none!important}.t-rose .xav{width:168px;height:168px;border-radius:40px;border:2px solid #a78bfa;box-shadow:0 0 34px #8b5cf6aa,inset 0 0 20px #8b5cf655}.t-rose .xid{flex:1;padding-bottom:14px}.t-rose .xh h1{justify-content:flex-start;color:#c4b5fd;font-size:clamp(34px,10vw,44px)}.t-rose .xh h1 svg{color:#a78bfa}.t-rose .xsub{font-size:15px}
.t-rose .pb b{background:#a78bfa}.t-rose .pl{box-shadow:0 0 0 1px #a78bfa66}.t-rose .xth.script{text-shadow:0 0 18px #8b5cf6aa}.t-rose .xloc{margin-top:8px}.t-rose .xit .chips span{border-color:#a78bfa66}
/* scrap: полароиды, рукописное */
.t-scrap .xh{min-height:520px;align-items:flex-start;text-align:left;justify-content:flex-start}.t-scrap .xav{width:290px;height:300px;border-radius:3px;border:12px solid #f3efe6;border-bottom-width:48px;transform:rotate(-6deg);box-shadow:0 18px 40px #000a;position:absolute;left:4px;top:118px}.t-scrap .xav::after{content:"";position:absolute;left:50%;top:-18px;width:70px;height:22px;background:#c9c3b2c0;transform:translateX(-50%) rotate(4deg)}
.t-scrap .xid{position:absolute;right:0;top:30px;width:55%;text-align:right}.t-scrap .xh h1{font:700 clamp(60px,18vw,84px)/.9 Caveat,cursive;transform:rotate(-4deg);display:block;letter-spacing:0}.t-scrap .xh h1 svg{display:none}.t-scrap .xsub{font:700 20px Caveat,cursive;color:#e8dcc6;margin-top:10px}
.t-scrap .xloc{position:absolute;right:0;top:300px;margin:0;background:#e9e2d0;color:#2a2418;border:0;border-radius:2px;transform:rotate(6deg);padding:12px 14px;font:700 17px Caveat,cursive;white-space:normal;max-width:130px;text-align:center}
.t-scrap .xth.script{color:#e8dcc6;text-align:left}
/* moon: засечки по центру */
.t-moon .xh{padding-top:50px;gap:8px}.t-moon .xav{width:92px;height:92px;border-radius:50%;order:3;margin-top:10px}.t-moon .xhi{display:block;order:0;font-size:11px;letter-spacing:.34em;text-transform:uppercase;color:#ffffff99}.t-moon .xid{display:flex;flex-direction:column;align-items:center}.t-moon .xh h1{font:400 clamp(52px,16vw,68px)/1 "Playfair Display",Georgia,serif;margin:0}.t-moon .xh h1 svg{display:none}.t-moon .xsub{font-size:14px;letter-spacing:.04em}
/* smoke: хром-дым, слева, меню */
.t-smoke .xh{align-items:flex-start;text-align:left;padding-top:84px;min-height:44svh;justify-content:center}.t-smoke .xh h1{justify-content:flex-start;font-size:clamp(44px,14vw,58px);letter-spacing:-.04em}.t-smoke .xsub{max-width:210px;font-size:17px}.t-smoke .xav{display:none}.t-smoke .xloc{position:absolute;right:0;top:4px;margin:0}
.t-smoke .menu{position:absolute;left:0;top:8px;width:30px;height:30px;color:#fff;z-index:2}
/* chrome: по центру, зелёная точка, хром */
.t-chrome .xh{padding-top:30px}.t-chrome .xav{width:124px;height:124px;border-radius:30px;border:2px solid #ffffff55}.t-chrome .xloc{position:absolute;right:0;top:0;margin:0}
/* mono: светлый журнальный */
.t-mono{--tx:#121214;--mu:#4c4c54;--gl:none;--gb:#12121426;--sh:none;--tile:#fff;--ic:#121214;--pb:#121214;--pt:#fff;--ac:#121214;--ov:none;--wc:#121214;--bk:#fff;--bl:0px}
.t-mono .xh{align-items:flex-start;text-align:left;min-height:380px;padding-top:36px;justify-content:flex-start}.t-mono .xh h1{font:700 clamp(54px,17vw,72px)/1 "Golos Text",sans-serif;justify-content:flex-start;letter-spacing:-.05em;margin-top:56px}.t-mono .xh h1::after{content:"—";font-weight:400;margin-left:8px}.t-mono .xh h1 svg{display:none}.t-mono .xsub{font-size:17px}
.t-mono .xav{position:absolute;right:0;top:56px;width:150px;height:200px;border-radius:26px;border:0;box-shadow:0 14px 30px #0003}.t-mono .xloc{position:absolute;left:0;top:0;margin:0;background:none;border:0;color:#121214;padding:0;font-size:12px;letter-spacing:.12em;text-transform:uppercase;white-space:pre-line;max-width:90px;line-height:1.3}
.t-mono .mu{border-top:1px solid #12121426;border-bottom:1px solid #12121426;border-radius:0;padding:14px 0}.t-mono .pl{border:0}.t-mono .soc{border-bottom:1px solid #12121426;padding-bottom:16px}.t-mono .a-line{border-left:0!important;padding:0}.t-mono .ab h2{justify-content:space-between}
.t-mono .glbtop{position:absolute;right:0;top:0;width:24px;height:24px}
/* earth: планета */
.t-earth .xh{padding-top:20px}.t-earth .xav{width:124px;height:124px;border-radius:32px;border:1px solid #ffffff55;box-shadow:0 0 50px #4d7cff55}.t-earth .xh h1{gap:12px}.t-earth .xon{padding:6px 14px;border-radius:999px;background:#ffffff14;border:1px solid #ffffff30;font-size:13px;margin:0}.t-earth .xsub{text-decoration:underline;text-underline-offset:8px;text-decoration-thickness:1px;margin-top:6px}.t-earth .xloc{position:absolute;right:0;top:0;margin:0}
/* graffiti: фиолетовая комната, моно */
.t-graffiti{--ac:#a78bfa;--gl:linear-gradient(150deg,#7c3aed40,#14062e99);--gb:#a78bfa66;--tile:#8b5cf633;--ic:#c4b5fd;--pb:#8b5cf6;--pt:#fff;--tx:#efe7ff;--mu:#c4b5fdcc;--wc:#a78bfa;font-family:ui-monospace,Menlo,Consolas,monospace}
.t-graffiti .xh{padding-top:50px}.t-graffiti .xav{width:112px;height:112px;border-radius:26px;border:2px solid #a78bfa;box-shadow:0 0 30px #8b5cf6aa}.t-graffiti .xh h1{font:700 clamp(54px,17vw,70px)/1 Caveat,cursive;color:#a78bfa;text-shadow:0 0 22px #8b5cf6aa;transform:rotate(-3deg)}.t-graffiti .xh h1 svg{display:none}.t-graffiti .xsub{font-size:14px;letter-spacing:.1em}.t-graffiti .ab p,.t-graffiti .mt{font-family:inherit}.t-graffiti .xloc{margin-top:6px}
/* statue: серьёзный журнал */
.t-statue{--tx:#efe3d9;--mu:#c8b8ac;--gl:none;--gb:#ffffff1f;--sh:none;--tile:#ffffff10;--bl:0px;--pb:#ef4444;--pt:#fff;--ov:linear-gradient(90deg,#0009,#0003)}
.t-statue .xh{align-items:flex-start;text-align:left;padding-top:70px;min-height:46svh;justify-content:center}.t-statue .xav{display:none}.t-statue .xh h1{font:400 clamp(60px,19vw,84px)/.95 "Playfair Display",Georgia,serif;letter-spacing:-.03em;color:#ead3c2;margin:6px 0 0;justify-content:flex-start}.t-statue .xh h1 svg{display:none}
.t-statue .xsub{font-size:12px;letter-spacing:.22em;text-transform:uppercase;line-height:1.9;max-width:120px;position:absolute;left:0;top:0}.t-statue .xloc{display:none}
.t-statue .mu{border-radius:20px;background:#00000066}
/* sky: небо, орбита */
.t-sky .xh{padding-top:30px}.t-sky .xav{width:96px;height:96px;border-radius:28px;border:1px solid #ffffff80}.t-sky .xav::before{content:none}.t-sky .orb{position:absolute;left:50%;top:6px;width:300px;height:140px;transform:translateX(-50%) rotate(-12deg);opacity:.7;pointer-events:none}
.t-sky .xh h1{margin-top:16px}.t-sky{--ov:linear-gradient(#0000 55%,#0004)}.t-sky .xloc{position:absolute;right:0;top:0;margin:0}
/* bigtype: светлый, гигант */
.t-bigtype{--tx:#121214;--mu:#3f3f46;--gl:none;--gb:#12121426;--sh:none;--tile:#fff;--ic:#121214;--pb:#fff;--pt:#121214;--ac:#121214;--ov:none;--wc:#ffffffcc;--bk:#fff;--bl:0px}
.t-bigtype .xh{align-items:flex-start;text-align:left;min-height:310px;justify-content:flex-start}.t-bigtype .xh h1{position:absolute;left:-6px;top:0;margin:0;font:700 var(--nf,170px)/.86 Oswald,sans-serif;text-transform:uppercase;letter-spacing:-.02em;color:#121214;display:block;white-space:nowrap}.t-bigtype .xh h1 svg{display:none}
.t-bigtype .xid{position:static;width:auto}.t-bigtype .xav{position:absolute;left:0;bottom:30px;width:112px;height:112px;border-radius:24px;border:3px solid #ffffffd0;z-index:2}.t-bigtype .xsub{position:absolute;left:124px;bottom:34px;font-weight:700;color:#121214}.t-bigtype .xloc{position:absolute;left:124px;bottom:6px;margin:0;background:none;border:0;color:#3f3f46;padding:0;font-size:14px}.t-bigtype .xon{display:none}
.t-bigtype .mu{background:#121214;color:#fff;border-radius:999px;border:0;--mu:#ffffff99}.t-bigtype .mu .pl{background:#fff;color:#121214;border:0}.t-bigtype .xth.italic{font-size:20px}
.t-bigtype .soc a{background:none}
/* forest: цитата */
.t-forest .xh{padding-top:50px}.t-forest .xav{width:104px;height:104px;border-radius:30px;border:1px solid #ffffff55}.t-forest .xon{margin-top:2px}.t-forest .moon{position:absolute;right:0;top:0;width:26px;height:26px;opacity:.9}.t-forest .xloc{display:none}
/* lilac: сумерки */
.t-lilac{--ac:#e9d5ff;--gl:linear-gradient(150deg,#ffffff1c,#7c3aed26);--gb:#e9d5ff3a;--tile:#3b0a6a47;--ic:#e9d5ff;--pb:#ffffff22;--tx:#fff;--mu:#f0e1ffc8;--wc:#e9d5ff}.t-lilac .xh{padding-top:24px}.t-lilac .xav{width:128px;height:128px;border-radius:36px;border:1px solid #ffffff66}.t-lilac .xth.script{text-align:right}.t-lilac .xloc{position:absolute;right:0;top:0;margin:0}
/* xp: окна */
.t-xp{--tx:#121a2b;--mu:#34405a;--gl:linear-gradient(#f4f7ffeb,#dfe8f9e6);--gb:#2b4a9a;--sh:2px 2px 0 #0a1f5c55,inset 0 0 0 1px #ffffffaa;--tile:#fff;--ic:#121a2b;--pb:#2a5bd7;--pt:#fff;--bl:3px;--ov:none;--wc:#2a5bd7}
.t-xp .xhd{background:linear-gradient(#f4f7ffeb,#dfe8f9e6);border:1px solid #2b4a9a;box-shadow:var(--sh)}.t-xp .xin{display:flex;gap:14px;align-items:center;padding:14px}.t-xp .xav{width:92px;height:92px;border-radius:2px;border:2px solid #2b4a9a}.t-xp .xid{text-align:left}.t-xp .xh h1{font:700 28px "Golos Text",sans-serif;margin:0;justify-content:flex-start}.t-xp .xh h1 svg{display:none}
.tb{display:flex;align-items:center;gap:4px;padding:5px 8px;color:#fff;font:700 14px "Golos Text",sans-serif;background:linear-gradient(#5b8cf0,#2a5bd7)}.tb span{flex:1}.tb i{width:17px;height:17px;border:1px solid #fff;border-radius:3px;background:#ffffff33}
.t-xp .win{border-radius:3px;padding:0;overflow:hidden}.t-xp .win>.in{padding:14px 16px}.t-xp .ab,.t-xp .xit,.t-xp .mu,.t-xp .s-xp,.t-xp .lk a,.t-xp .fm{border-radius:3px}.t-xp .mu{padding:0;flex-wrap:wrap}.t-xp .mu .in{display:flex;align-items:center;gap:14px;padding:14px 16px;width:100%}.t-xp .chips span{border-radius:3px;background:#fff}.t-xp .xth{color:#fff;text-shadow:0 1px 3px #0a1f5c}.t-xp .xft{color:#fff}.t-xp .fm input,.t-xp .fm textarea{background:#fff}
.t-xp .win .ab-in{padding:14px 16px}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const L10 = {
  ru: { about: 'Обо мне', hello: 'Привет, я', welcome: 'Добро пожаловать', now: 'Сейчас играет', links: 'Ссылки', interests: 'Интересы', cur: 'Сейчас слушаю', down: 'ниже' },
  en: { about: 'About me', hello: "Hello, I'm", welcome: 'Welcome to my page', now: 'Now playing', links: 'Links', interests: 'Interests', cur: 'Currently listening', down: 'scroll' },
};

const SPK = (x, y, z) => `<svg class="spk" style="left:${x}%;top:${y}%;--z:${z}px" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 0c.7 7 4.4 10.7 12 12-7.6 1.3-11.3 5-12 12-.7-7-4.4-10.7-12-12C7.6 10.7 11.3 7 12 0z"/></svg>`;
const GLOBE = '<svg class="glb" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width=".8" aria-hidden="true"><circle cx="50" cy="50" r="30"/><ellipse cx="50" cy="50" rx="30" ry="11"/><ellipse cx="50" cy="50" rx="11" ry="30"/><ellipse cx="50" cy="50" rx="46" ry="16" transform="rotate(-25 50 50)"/><circle cx="84" cy="30" r="2" fill="currentColor"/></svg>';
const ORBIT = '<svg class="orb" viewBox="0 0 300 140" fill="none" stroke="#fff" stroke-width="1" aria-hidden="true"><ellipse cx="150" cy="70" rx="145" ry="55"/><circle cx="12" cy="52" r="3" fill="#fff"/></svg>';
const waveSvg = (seed) => { let h = 7; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) % 9973; let bars = ''; for (let i = 0; i < 38; i++) { h = (h * 1103515245 + 12345) % 2147483647; const v = 18 + (h % 82); bars += `<rect x="${(i * 1.9).toFixed(1)}" y="${((100 - v) / 100 * 20).toFixed(1)}" width="1.1" height="${(v / 100 * 20).toFixed(1)}" rx=".5"/>`; } return `<svg class="wv" viewBox="0 0 72 20" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`; };

function renderStyled(page, origin, c) {
  const { esc, ext, BASE, lucideSvg, go, opts } = c;
  const PUBL = require('./uzel-i18n').PUB;
  const lang = PUBL[ext.lang] ? ext.lang : 'ru';
  const L = PUBL[lang];
  const st = TPL[ext.style] ? ext.style : 'glass';
  const T = TPL[st];
  const bg = ext.bg === 'none' ? '' : (BGS.includes(ext.bg) && ext.bg ? ext.bg : T.bg);
  const sp = lucideSvg('sparkles');
  const nf = Math.max(62, Math.min(200, Math.floor(380 / (0.6 * Math.max(3, String(page.name).length)))));
  const nfo = Math.max(70, Math.min(240, Math.floor(390 / (0.5 * Math.max(3, String(page.name).length)))));
  const m = page.music;
  const cls = (T.p === 'wave' ? 'p-wave' : T.p === 'pill' ? 'p-pill' : T.p === 'min' ? 'p-min' : 'p-glass');
  let music = '';
  if (m && m.title) {
    const cover = m.cover ? `<img src="/api/uzel/media/${esc(m.cover)}" alt="" width="58" height="58">` : lucideSvg('music-2');
    const btn = m.audio
      ? `<button class="pl" type="button" data-src="/api/uzel/media/${esc(m.audio)}" aria-label="Play">${lucideSvg('play').replace('<svg', '<svg class="i1"')}${lucideSvg('pause').replace('<svg', '<svg class="i2"')}</button>`
      : `<a class="pl" href="${go('music')}" rel="nofollow noopener ugc" aria-label="Play">${lucideSvg('play')}</a>`;
    const inner = `<div class="cv">${cover}</div><div class="mt"><b>${esc(m.title)}</b>${m.artist ? `<span>${esc(m.artist)}</span>` : ''}${waveSvg(m.title)}${m.audio ? '<i class="pb"><b></b></i>' : ''}</div>${btn}`;
    music = T.lay === 'xp'
      ? `<div class="mu glass win ${cls}"><div class="tb"><span>${esc(L.now)}</span><i></i><i></i><i></i></div><div class="in">${inner}</div></div>`
      : `<div class="mu glass ${cls}">${inner}</div>`;
    if (st === 'smoke') music = `<div class="mu glass ${cls}" style="flex-wrap:wrap"><div style="width:100%;font-size:17px;font-weight:700">${esc(L.cur)}</div>${inner}</div>`;
  }
  const soc = c.soc ? `<div class="soc s-${T.s}">${c.soc}</div>` : '';
  const socX = T.lay === 'xp' && soc ? `<div class="glass win"><div class="tb"><span>${esc(L.links)}</span><i></i></div><div class="in">${soc}</div></div>` : soc;
  const arrow = lucideSvg('chevron-right').replace('<svg', '<svg class="ar"');
  const aboutTitle = T.a === 'arrow' || T.a === 'text' ? `${esc(L.about)} ${T.a === 'text' ? '→' : ''}${T.a === 'arrow' ? arrow : ''}` : `${esc(L.about)} ${T.a === 'card' ? (T.pin ? lucideSvg('map-pin') : sp) : ''}`;
  let about = '';
  if (page.bio) {
    const body = T.a === 'quote' ? `<p>“${esc(page.bio)}”</p>` : `<h2>${aboutTitle}</h2><p>${esc(page.bio)}</p>`;
    about = T.lay === 'xp'
      ? `<div class="ab glass win a-card"><div class="tb"><span>${esc(L.about)}</span><i></i><i></i><i></i></div><div class="in"><p>${esc(page.bio)}</p></div></div>`
      : `<div class="ab ${T.a === 'quote' || T.a === 'text' || T.a === 'line' ? '' : 'glass'} a-${T.a}">${body}${T.glb ? GLOBE : ''}</div>`;
  }
  const ints = (ext.interests || []).length ? `<div class="xit glass"><h2>${esc(L.interests)} ${T.lay === 'xp' ? '' : (st === 'rose' ? arrow : sp)}</h2><div class="chips">${ext.interests.map((i) => `<span>${esc(i)}</span>`).join('')}</div></div>` : '';
  const ct = c.infoBtns ? `<div class="ct">${c.infoBtns}</div>` : '';
  const lk = c.links ? `<div class="lk">${c.links}</div>` : '';
  const hello = ext.hello || (st === 'moon' ? L.welcome : L.hello);
  const loc = ext.location ? `<span class="xloc">${esc(ext.location)}</span>` : '';
  const online = ext.status ? `<span class="xon"><i></i>${esc(ext.status)}</span>` : '';
  const badge = T.badge ? lucideSvg('badge-check') : '';
  const od = T.od ? '<i class="od"></i>' : '';
  const sparkName = ['glass', 'night', 'smoke', 'chrome', 'earth', 'sky', 'lilac', 'forest'].includes(st) ? sp : '';
  const idb = `<div class="xid"><p class="xhi">${esc(hello)}</p><h1>${esc(page.name)}${badge || sparkName}${st === 'earth' ? online : ''}</h1>${page.subtitle ? `<p class="xsub">${esc(page.subtitle)}</p>` : ''}${st === 'earth' ? '' : online}</div>`;
  const av = `<div class="xav" style="background:${c.gradient}">${c.avatar}${od}</div>`;
  const extra = (T.menu ? `${lucideSvg('menu').replace('<svg', '<svg class="menu"')}` : '') + (T.orbit ? ORBIT : '') + ((T.moon || st === 'rose') ? lucideSvg('moon').replace('<svg', '<svg class="moon"') : '') + (st === 'mono' ? lucideSvg('globe').replace('<svg', '<svg class="glbtop"') : '');
  const roseHello = st === 'rose' ? `<p class="hb">${esc(hello)}<br>${lang === 'en' ? "I'm" : ''} <b>${esc(page.name)}.</b></p>` : '';
  const header = T.lay === 'xp'
    ? `<div class="xhd"><div class="tb"><span>${esc(L.about)}</span><i></i><i></i><i></i></div><div class="xin">${av}${idb}</div></div>`
    : `<header class="xh l-${T.lay}">${extra}${roseHello}${loc}${av}${idb}</header>`;
  const thk = T.thk || '';
  const thanks = ext.thanks ? `<p class="xth ${thk}">${esc(ext.thanks)}</p>` : '';
  const scroll = T.scroll ? `<div class="xsc">${esc(L.down)}${lucideSvg('chevron-right')}</div>` : '';
  const bar = T.bar ? '<div class="bar"></div>' : '';
  const style = `--bgi:${bg ? `url(${BASE}/assets/bg/${bg}.webp)` : 'none'};${T.flt && !ext.bg ? `--flt:${T.flt};` : ''}${T.lay === 'giant' ? `--nf:${nf}px;` : ''}${T.lay === 'gianto' ? `--nf:${nfo}px;` : ''}${c.accentCss ? c.accentCss + ';' : ''}`;
  const hasAudio = !!(m && m.audio);
  const theme = T.light ? '#e8e4da' : '#07070b';
  const body = T.lay === 'xp' ? `${header}${music}${socX}${about}${ints}${ct}${lk}${c.form}` : T.first === 'soc' ? `${header}${about}${soc}${music}${ints}${ct}${lk}${c.form}` : `${header}${music}${soc}${about}${ints}${ct}${lk}${c.form}`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(page.name)} · Узел</title><meta name="description" content="${c.desc}"><meta name="robots" content="noindex,nofollow">
<meta property="og:title" content="${esc(page.name)}"><meta property="og:description" content="${c.desc}"><meta property="og:type" content="profile">${c.img}
<meta name="theme-color" content="${theme}"><link rel="icon" href="${BASE}/assets/favicon.svg" type="image/svg+xml"><style>${CSS(BASE)}</style></head>
<body class="x t-${st}${ext.hello ? ' has-hello' : ''}" style="${style}"><div class="bgl"></div><main class="xw">${(T.spk || []).map((d) => SPK(d[0], d[1], d[2])).join('')}${body}${scroll}${thanks}${bar}<div class="xft">${c.badge}<a href="${c.report}">${c.reportLabel}</a></div></main>${hasAudio ? `<script>${PLAYER_JS}</script>` : ''}</body></html>`;
}

module.exports = { STYLES, BGS, STYLE_BG, PLAYER_HASH, renderStyled };
