// Стили страниц «Узла»: стеклянные карточки, плеер, фоны. Подключается из uzel.js (renderPublicPage).
const crypto = require('crypto');
const STYLES = ['classic', 'glass', 'bigname', 'neon', 'planet', 'editorial', 'chrome', 'xp', 'polaroid', 'soft'];
const BGS = ['none', 'night', 'chrome', 'chrome2', 'sky', 'rose', 'planet', 'statue', 'polaroid', 'ocean', 'room', 'forest', 'orbit', 'clouds', 'dusk', 'xp', 'paper'];
const STYLE_BG = { glass: 'forest', bigname: 'night', neon: 'rose', planet: 'ocean', editorial: 'statue', chrome: 'chrome', xp: 'xp', polaroid: 'polaroid', soft: 'paper' };
const LIGHT = { soft: 1, xp: 1 };

const PLAYER_JS = "(function(){var a=null,c=null;document.addEventListener('click',function(e){var b=e.target.closest('button.pl');if(!b)return;if(!a){a=new Audio();a.addEventListener('timeupdate',function(){if(c){var p=c.parentNode.querySelector('.pb b');if(p&&a.duration)p.style.width=(a.currentTime/a.duration*100)+'%'}});a.addEventListener('ended',function(){if(c)c.classList.remove('on')})}if(c===b&&!a.paused){a.pause();b.classList.remove('on');return}if(c&&c!==b)c.classList.remove('on');if(c!==b){a.src=b.getAttribute('data-src');c=b}a.play();b.classList.add('on')})})();";
const PLAYER_HASH = 'sha256-' + crypto.createHash('sha256').update(PLAYER_JS).digest('base64');

const STYLE_CSS = (BASE) => `
@font-face{font-family:Unbounded;font-weight:800;src:url(${BASE}/assets/fonts/unbounded-cyrillic-800-normal.woff2) format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:Unbounded;font-weight:800;src:url(${BASE}/assets/fonts/unbounded-latin-800-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+2000-206F,U+20AC,U+2122,U+2212}
@font-face{font-family:"Golos Text";font-weight:400 700;src:url(${BASE}/assets/fonts/golos-text-cyrillic-600-normal.woff2) format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:"Golos Text";font-weight:400 700;src:url(${BASE}/assets/fonts/golos-text-latin-600-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+2000-206F,U+20AC,U+2122,U+2212}
@font-face{font-family:Oswald;font-weight:700;src:url(${BASE}/assets/fonts/oswald-cyrillic-700-normal.woff2) format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:Oswald;font-weight:700;src:url(${BASE}/assets/fonts/oswald-latin-700-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+2000-206F,U+20AC,U+2122,U+2212}
@font-face{font-family:Playfair Display;font-weight:400;src:url(${BASE}/assets/fonts/playfair-display-cyrillic-400-normal.woff2) format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:Playfair Display;font-weight:400;src:url(${BASE}/assets/fonts/playfair-display-latin-400-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+2000-206F,U+20AC,U+2122,U+2212}
@font-face{font-family:Playfair Display;font-style:italic;font-weight:400;src:url(${BASE}/assets/fonts/playfair-display-cyrillic-400-italic.woff2) format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:Playfair Display;font-style:italic;font-weight:400;src:url(${BASE}/assets/fonts/playfair-display-latin-400-italic.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+2000-206F,U+20AC,U+2122,U+2212}
@font-face{font-family:Caveat;font-weight:700;src:url(${BASE}/assets/fonts/caveat-cyrillic-700-normal.woff2) format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:Caveat;font-weight:700;src:url(${BASE}/assets/fonts/caveat-latin-700-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+2000-206F,U+20AC,U+2122,U+2212}
*{box-sizing:border-box}html{min-height:100%;background:#050507}
body.x{margin:0;min-height:100svh;font:16px/1.4 "Golos Text",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:var(--tx)}
.x{--tx:#fff;--mu:#ffffffb0;--gl:linear-gradient(150deg,#ffffff17,#ffffff07);--gb:#ffffff1c;--sh:inset 0 1px 0 #ffffff22,0 12px 32px #0000005c;--tile:#00000047;--ic:#fff;--pb:#ffffff1a;--pt:#fff;--ac:#fff;--ov:linear-gradient(#0000 40%,#0006);--bl:26px}
.bgl{position:fixed;inset:0;z-index:-1;background:#07070b var(--bgi,none) center top/cover no-repeat}.bgl::after{content:"";position:absolute;inset:0;background:var(--ov)}
.xw{width:min(460px,100%);margin:0 auto;padding:max(26px,env(safe-area-inset-top)) 18px 30px;display:flex;flex-direction:column;gap:14px;min-height:100svh;position:relative}
.g,.xw .lk a,.xw .ct a,.xw .fm,.xw .soc a{background:var(--gl);border:1px solid var(--gb);box-shadow:var(--sh);-webkit-backdrop-filter:blur(var(--bl)) saturate(150%);backdrop-filter:blur(var(--bl)) saturate(150%)}
.g{border-radius:28px;padding:18px 20px}
.xh{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding-top:6px}
.xav{width:112px;height:112px;border-radius:34px;overflow:hidden;display:grid;place-items:center;font:800 36px Unbounded,sans-serif;color:#fff;letter-spacing:-.05em;border:1px solid #ffffff40;box-shadow:0 18px 40px #0007,inset 0 0 0 1px #ffffff1a}.xav img{width:100%;height:100%;object-fit:cover;display:block}
.xh h1{margin:10px 0 0;font:700 clamp(30px,9vw,38px)/1.05 "Golos Text",sans-serif;letter-spacing:-.03em;display:flex;align-items:center;gap:10px;overflow-wrap:anywhere}
.xh h1 svg{width:.6em;height:.6em;flex:none;opacity:.9}
.xsub{margin:0;color:var(--mu);font-weight:500;font-size:17px;overflow-wrap:anywhere}.xhi{display:none;color:var(--mu);font-size:17px;font-weight:500;margin:0}.xid{width:100%}.xh h1{justify-content:center}.xw h2 svg{width:16px;height:16px;opacity:.85;flex:none}
.x-bigname .xh h1,.x-neon .xh h1,.x-editorial .xh h1,.x-chrome .xh h1,.x-polaroid .xh h1,.x-xp .xh h1{justify-content:flex-start}
.mu{display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:26px}
.mu .cv{width:58px;height:58px;border-radius:16px;flex:none;overflow:hidden;background:#ffffff1f;display:grid;place-items:center;color:var(--mu)}.mu .cv img{width:100%;height:100%;object-fit:cover}.mu .cv svg{width:24px;height:24px}
.mt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.mt b{font-size:16px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt span{color:var(--mu);font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb{display:block;height:3px;border-radius:2px;background:#ffffff2e;margin-top:8px;overflow:hidden}.pb b{display:block;height:100%;width:0;background:var(--tx);border-radius:2px}
.pl{width:48px;height:48px;border-radius:50%;border:1px solid #ffffff30;background:var(--pb);color:var(--pt);display:grid;place-items:center;flex:none;cursor:pointer;text-decoration:none;padding:0}.pl svg{width:20px;height:20px;fill:currentColor;stroke:none}.pl .i2{display:none}.pl.on .i1{display:none}.pl.on .i2{display:block}
.xw .soc{display:flex;gap:10px;justify-content:center;margin:0;padding:12px;border-radius:26px;background:var(--gl);border:1px solid var(--gb);box-shadow:var(--sh);-webkit-backdrop-filter:blur(var(--bl)) saturate(150%);backdrop-filter:blur(var(--bl)) saturate(150%)}
.xw .soc a{flex:1 1 0;max-width:68px;height:60px;border-radius:20px;display:grid;place-items:center;color:var(--ic);background:var(--tile);box-shadow:inset 0 1px 0 #ffffff1f;transition:transform .2s}.xw .soc a:hover{transform:translateY(-2px)}.xw .soc svg{width:25px;height:25px}
.ab h2,.xw .fm h2,.xit h2{margin:0 0 8px;font:700 19px "Golos Text",sans-serif;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}.ab h2 svg{width:16px;height:16px;opacity:.85}.ab p{margin:0;color:var(--mu);font-size:16px;white-space:pre-line;overflow-wrap:anywhere}
.xit{display:flex;flex-direction:column}.chips{display:flex;flex-wrap:wrap;gap:8px}.chips span{padding:8px 15px;border-radius:999px;background:var(--tile);border:1px solid var(--gb);font-size:14.5px;font-weight:600}
.xw .ct{display:flex;flex-wrap:wrap;gap:10px;margin:0}.xw .ct a{display:flex;align-items:center;gap:8px;height:48px;padding:0 18px;border-radius:999px;color:var(--tx);text-decoration:none;font-weight:600;font-size:15px}.xw .ct svg{width:18px;height:18px}
.xw .lk{display:flex;flex-direction:column;gap:10px;margin:0}.xw .lk a{min-height:60px;border-radius:22px;display:flex;align-items:center;gap:14px;padding:0 18px;color:var(--tx);text-decoration:none;font-weight:600;font-size:16.5px;text-align:left;transition:transform .2s}.xw .lk a:hover{transform:translateY(-2px)}
.xw .lk a span{flex:1;overflow:hidden;text-overflow:ellipsis;overflow-wrap:anywhere}.xw .lk svg{width:21px;height:21px;flex:none}.xw .lk .ar{opacity:.55;width:19px}.xw .lk small{display:block;font-weight:500;font-size:13px;opacity:.7;margin-top:2px;white-space:normal}
.xw .lk .hd{font:700 13px "Golos Text",sans-serif;letter-spacing:.14em;text-transform:uppercase;opacity:.65;margin:10px 2px -2px;text-align:left}
.xw .fm{display:flex;flex-direction:column;gap:10px;margin:0;padding:18px;border-radius:26px;text-align:left}.xw .fm input,.xw .fm textarea{width:100%;border:1px solid var(--gb);border-radius:16px;padding:14px 16px;font:600 16px "Golos Text",system-ui,sans-serif;color:var(--tx);background:#00000030;outline:0}.xw .fm input::placeholder,.xw .fm textarea::placeholder{color:var(--mu)}.xw .fm button{min-height:52px;border:0;border-radius:18px;background:var(--pb);color:var(--pt);font:700 16px "Golos Text",sans-serif;cursor:pointer}.xw .fm .hd{margin:0}
.xth{margin:8px 0 0;text-align:center;color:var(--mu);font-weight:600}
.xft{margin:6px 0 0;display:flex;gap:18px;justify-content:center;font-size:13.5px;color:var(--mu)}.xft a{color:inherit}
/* ---- светлые ---- */
.x-soft{--pb:#121214;--pt:#fff;--tx:#121214;--mu:#55555c;--gl:linear-gradient(#ffffffe6,#ffffffb0);--gb:#ffffff;--sh:0 14px 30px #1a1a2022;--tile:#ffffff;--ic:#121214;--ac:#121214;--ov:none}.x-soft .pb{background:#12121422}.x-soft .xh{padding-top:26px}.x-soft .xav{border-color:#fff;box-shadow:0 16px 34px #0003}.x-soft .xw .fm input,.x-soft .xw .fm textarea{background:#ffffff90}
/* ---- glass: по центру, мягкое стекло ---- */
/* ---- bigname: огромное имя ---- */
.x-bigname .xh{position:relative;align-items:flex-start;text-align:left;min-height:350px;padding-top:34px}
.x-bigname .xh h1{position:absolute;left:-4px;top:26px;margin:0;font:700 var(--nf,170px)/.86 Oswald,"Golos Text",sans-serif;letter-spacing:-.02em;text-transform:none;background:linear-gradient(#ffffffee,#ffffff66 85%);-webkit-background-clip:text;background-clip:text;color:transparent;display:block;white-space:nowrap}
.x-bigname .xh h1 svg{display:none}.x-bigname .xhi{display:none}.x-bigname .xsub{position:absolute;left:0;bottom:6px;z-index:1;font-size:15px;max-width:150px}.x-bigname .xid{position:static;width:auto}
.x-bigname .xav{position:absolute;right:6px;bottom:0;width:150px;height:190px;border-radius:70px 70px 26px 26px;border:0;background-color:#0003;box-shadow:0 20px 50px #0009}
/* ---- neon ---- */
.x-neon{--pb:#14062e;--pt:#c4b5fd;--ac:#a78bfa;--gl:linear-gradient(150deg,#8b5cf633,#14062e88);--gb:#a78bfa55;--tile:#8b5cf61f;--ic:#c4b5fd;--pb:#14062e;--pt:#c4b5fd;--sh:inset 0 1px 0 #c4b5fd33,0 0 28px #8b5cf633;--tx:#f3ecff;--mu:#c9b8f0cc}
.x-neon .xh{flex-direction:row;align-items:center;text-align:left;gap:18px;flex-wrap:wrap}.x-neon .xav{width:132px;height:132px;border-radius:34px;border:2px solid #a78bfa;box-shadow:0 0 34px #8b5cf6aa,inset 0 0 20px #8b5cf655}
.x-neon .xid{min-width:0;flex:1}.x-neon .xhi{display:block}.x-neon .xh h1{color:#c4b5fd;margin-top:2px;font-size:clamp(34px,10vw,44px)}.x-neon .xsub{font-size:15px}.x-neon .pl{box-shadow:0 0 0 1px #a78bfa66}.x-neon .pb b{background:#a78bfa}
.x-neon .xth{font:700 30px/1 Caveat,cursive;color:#a78bfa;transform:rotate(-4deg);text-align:right;margin-top:14px;text-shadow:0 0 18px #8b5cf6aa}
/* ---- planet: по центру, засечки ---- */
.x-planet .xhi{display:block}.x-planet .xh{padding-top:58px;gap:8px}.x-planet .xav{width:92px;height:92px;border-radius:50%;order:3;margin-top:10px}.x-planet .xhi{order:0;font-size:11px;letter-spacing:.34em;text-transform:uppercase;color:#ffffff99;margin-bottom:6px}
.x-planet .xid{display:flex;flex-direction:column;align-items:center}.x-planet .xh h1{font:400 clamp(52px,16vw,68px)/1 "Playfair Display",Georgia,serif;letter-spacing:-.01em;margin:0}.x-planet .xh h1 svg{display:none}.x-planet .xsub{font-size:14px;letter-spacing:.04em}
.x-planet .xh{flex-direction:column}.x-planet .xw{padding-top:max(40px,env(safe-area-inset-top))}
/* ---- editorial ---- */
.x-editorial{--tx:#efe3d9;--mu:#c8b8ac;--gl:none;--gb:#ffffff1f;--sh:none;--tile:#ffffff10;--bl:0px;--pb:#efe3d9;--pt:#111;--ov:linear-gradient(90deg,#0009,#0003)}
.x-editorial .xh{align-items:flex-start;text-align:left;padding-top:70px}.x-editorial .xav{width:88px;height:88px;border-radius:50%;order:3;margin-top:14px;filter:grayscale(.4)}
.x-editorial .xh h1{font:400 clamp(60px,19vw,84px)/.95 "Playfair Display",Georgia,serif;letter-spacing:-.03em;color:#ead3c2;margin:0}.x-editorial .xh h1 svg{display:none}.x-editorial .xhi{display:none}
.x-editorial .xid::after{content:"";display:block;width:42px;height:1px;background:#ead3c2;margin-top:18px}.x-editorial .xsub{font-size:14px;letter-spacing:.14em;text-transform:uppercase;margin-top:12px}
.x-editorial .g,.x-editorial .soc,.x-editorial .lk a,.x-editorial .ct a,.x-editorial .fm,.x-editorial .mu{background:none;border:0;border-top:1px solid #ffffff22;border-radius:0;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none;padding-left:2px;padding-right:2px}
.x-editorial .soc{justify-content:flex-start;gap:22px}.x-editorial .soc a{background:none;border:0;max-width:none;flex:none;height:40px;width:30px}.x-editorial .mu .cv{border-radius:2px}.x-editorial .pl{border-radius:2px}.x-editorial .chips span{border-radius:2px}
.x-editorial .xth{font:italic 400 18px "Playfair Display",serif;text-align:left}
/* ---- chrome: слева, крупно ---- */
.x-chrome .xh{align-items:flex-start;text-align:left;padding-top:80px}.x-chrome .xh h1{font:700 clamp(44px,14vw,60px)/1 "Golos Text",sans-serif;letter-spacing:-.04em}.x-chrome .xav{width:84px;height:84px;border-radius:26px;order:3;margin-top:12px}
.x-chrome .xsub{font-size:17px;max-width:210px}.x-chrome{--gl:linear-gradient(150deg,#ffffff1c,#ffffff08);--tile:#0000004d}
/* ---- xp ---- */
.x-xp{--tx:#121a2b;--mu:#34405a;--gl:linear-gradient(#f4f7ffeb,#dfe8f9e6);--gb:#2b4a9a;--sh:2px 2px 0 #0a1f5c55,inset 0 0 0 1px #ffffffaa;--tile:#fff;--ic:#121a2b;--pb:#2a5bd7;--pt:#fff;--bl:3px;--ov:none}
.x-xp .xh{flex-direction:row;align-items:center;text-align:left;gap:14px;padding:0}.x-xp .xh .xav{width:92px;height:92px;border-radius:2px;border:2px solid #2b4a9a;order:0}.x-xp .xh h1,.x-xp .xid h1{font:700 28px "Golos Text",sans-serif;margin:0;color:#121a2b;justify-content:flex-start;text-shadow:none}.x-xp .xid{text-align:left}.x-xp .xh h1 svg{display:none}.x-xp .xhi{display:none}
.x-xp .xhd{background:linear-gradient(#f4f7ffeb,#dfe8f9e6);border:1px solid #2b4a9a;box-shadow:var(--sh);padding:0}.x-xp .xhd .tb{margin:0}.x-xp .xhd .xin{display:flex;gap:14px;align-items:center;padding:14px}
.x-xp .g,.x-xp .lk a,.x-xp .soc,.x-xp .fm,.x-xp .ct a{border-radius:3px}.x-xp .g::before,.x-xp .soc::before,.x-xp .mu::before{content:attr(data-t);display:flex;align-items:center;margin:-18px -20px 14px;padding:5px 10px;color:#fff;font:700 14px "Golos Text",sans-serif;background:linear-gradient(#5b8cf0,#2a5bd7);border-radius:2px 2px 0 0}
.x-xp .mu::before{position:absolute;left:0;right:0;top:0;margin:0}.x-xp .mu{position:relative;padding-top:46px}.x-xp .soc{padding-top:44px;position:relative}.x-xp .soc::before{position:absolute;left:0;right:0;top:0;margin:0}.x-xp .xw .lk a{min-height:52px}
.x-xp .xw .soc a{border-radius:3px}.x-xp .pl{border-radius:3px}.x-xp .chips span{border-radius:3px;background:#fff}.x-xp .xth{color:#fff;text-shadow:0 1px 3px #0a1f5c}.x-xp .xft{color:#fff}.x-xp .xw .fm input,.x-xp .xw .fm textarea{background:#fff}
.tb{display:flex;align-items:center;gap:4px;padding:5px 8px;color:#fff;font:700 14px "Golos Text",sans-serif;background:linear-gradient(#5b8cf0,#2a5bd7)}.tb span{flex:1}.tb i{width:17px;height:17px;border:1px solid #fff;border-radius:3px;background:#ffffff33}
/* ---- polaroid ---- */
.x-polaroid .xh{padding-top:22px;position:relative;min-height:330px;align-items:flex-start;text-align:left}
.x-polaroid .xav{width:190px;height:220px;border-radius:3px;border:10px solid #f3efe6;border-bottom-width:40px;transform:rotate(-5deg);box-shadow:0 18px 40px #000a;position:absolute;left:0;top:30px}
.x-polaroid .xav::after{content:"";position:absolute;left:50%;top:-18px;width:70px;height:22px;background:#c9c3b2c0;transform:translateX(-50%) rotate(4deg)}
.x-polaroid .xid{position:absolute;right:0;top:34px;width:48%;text-align:right}.x-polaroid .xh h1{font:700 clamp(44px,14vw,60px)/.9 Caveat,cursive;transform:rotate(-4deg);display:block;letter-spacing:0}.x-polaroid .xh h1 svg{display:none}.x-polaroid .xhi{display:none}.x-polaroid .xsub{font:700 20px Caveat,cursive;color:#e8dcc6;margin-top:10px}
.x-polaroid .xth{font:700 26px Caveat,cursive;text-align:left}

.spk{position:absolute;width:var(--z,24px);height:var(--z,24px);color:#fff;opacity:var(--o,.9);filter:drop-shadow(0 0 7px #ffffff88);pointer-events:none;z-index:0}
.x-neon .spk{color:#c4b5fd;filter:drop-shadow(0 0 9px #8b5cf6)}.x-soft .spk,.x-xp .spk{color:#111;filter:none}
.xw>*{position:relative;z-index:1}.xw>.spk{position:absolute;z-index:0}
.wv{display:none;width:100%;height:24px;margin-top:8px;color:var(--wc,#fff)}.wv rect{fill:currentColor}
.x-glass .wv,.x-neon .wv,.x-planet .wv,.x-chrome .wv{display:block}.x-neon{--wc:#a78bfa}.x-glass,.x-planet,.x-chrome{--wc:#ffffffa6}
.xloc{position:absolute;right:0;top:0;padding:7px 14px;border-radius:999px;background:#0000004d;border:1px solid #ffffff2b;font-size:13px;font-weight:600;color:#fff;white-space:nowrap;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);z-index:2}
.xon{display:inline-flex;align-items:center;gap:8px;font-size:15px;color:var(--mu);font-weight:600;margin-top:4px}.xon i{width:9px;height:9px;border-radius:50%;background:#34d399;box-shadow:0 0 10px #34d399}
.has-hello .xhi{display:block}.xid{position:relative}
.xsc{display:flex;flex-direction:column;align-items:center;gap:2px;margin-top:10px;font-size:13px;letter-spacing:.06em;color:var(--mu)}.xsc svg{width:18px;height:18px;transform:rotate(90deg)}
.bar{width:130px;height:40px;background:repeating-linear-gradient(90deg,var(--tx) 0 2px,#0000 2px 4px,var(--tx) 4px 5px,#0000 5px 9px,var(--tx) 9px 12px,#0000 12px 14px,var(--tx) 14px 15px,#0000 15px 19px);opacity:.85;display:none}
.x-soft .bar,.x-editorial .bar{display:block;margin:8px 0 0}
.xlinkrow{display:flex;align-items:center;justify-content:space-between}
.x-soft .xth,.x-editorial .xth{text-align:left}
.x-glass .xh,.x-chrome .xh,.x-planet .xh,.x-editorial .xh{position:relative}
.x-glass .xloc,.x-planet .xloc,.x-chrome .xloc{top:6px}.x-soft .xloc,.x-xp .xloc{background:#ffffffb3;color:#111;border-color:#fff}.xid .xloc{position:static;display:inline-block;margin-top:8px}.x-soft .xid{display:flex;flex-direction:column;align-items:center}.x-glass .xh{padding-top:46px}.x-polaroid .xloc{position:absolute;left:0;bottom:0;top:auto;right:auto}
/* ---- общие мелочи ---- */
.x-glass .xh h1,.x-chrome .xh h1{text-shadow:0 2px 24px #0008}
@media(min-width:520px){.xw{padding-top:44px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const T = {
  ru: { about: 'Обо мне', hello: 'Привет, я', welcome: 'Добро пожаловать', thanks: 'Спасибо, что зашли', now: 'Сейчас играет', links: 'Ссылки', contact: 'Связь', interests: 'Интересы' },
  en: { about: 'About me', hello: "Hello, I'm", welcome: 'Welcome to my page', thanks: 'Thanks for visiting', now: 'Now playing', links: 'Links', contact: 'Contact', interests: 'Interests' },
};

const SPK = (x, y, z, o) => `<svg class="spk" style="left:${x}%;top:${y}%;--z:${z}px;--o:${o || 0.9}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 0c.7 7 4.4 10.7 12 12-7.6 1.3-11.3 5-12 12-.7-7-4.4-10.7-12-12C7.6 10.7 11.3 7 12 0z"/></svg>`;
const DECOR = {
  glass: [[84, 1.5, 30, 0.95], [5, 45, 16, 0.5], [92, 58, 14, 0.6]],
  bigname: [[80, 2, 26, 0.9], [4, 88, 22, 0.8], [90, 40, 14, 0.6]],
  neon: [[88, 46, 42, 0.95], [4, 74, 22, 0.8], [90, 8, 18, 0.7]],
  planet: [[8, 4, 22, 0.8], [88, 14, 16, 0.6]],
  editorial: [[88, 3, 24, 0.8]],
  chrome: [[6, 5, 34, 0.9], [86, 12, 22, 0.8], [90, 60, 14, 0.5]],
  xp: [],
  polaroid: [[88, 62, 20, 0.8], [6, 38, 24, 0.9], [78, 4, 18, 0.7]],
  soft: [[86, 3, 28, 0.9]],
};
const waveSvg = (seed) => { let h = 7; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) % 9973; let bars = ''; for (let i = 0; i < 38; i++) { h = (h * 1103515245 + 12345) % 2147483647; const v = 18 + (h % 82); bars += `<rect x="${(i * 1.9).toFixed(1)}" y="${((100 - v) / 100 * 20).toFixed(1)}" width="1.1" height="${(v / 100 * 20).toFixed(1)}" rx=".5"/>`; } return `<svg class="wv" viewBox="0 0 72 20" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`; };

function renderStyled(page, origin, c) {
  const { esc, ext, BASE, lucideSvg, go, opts } = c;
  const lang = ext.lang === 'en' ? 'en' : 'ru';
  const L = T[lang];
  const st = STYLES.includes(ext.style) ? ext.style : 'glass';
  const bg = ext.bg === 'none' ? '' : (BGS.includes(ext.bg) && ext.bg ? ext.bg : STYLE_BG[st]);
  const sp = lucideSvg('sparkles');
  const nf = Math.max(62, Math.min(190, Math.floor(400 / (0.62 * Math.max(3, String(page.name).length)))));
  const m = page.music;
  let music = '';
  if (m && m.title) {
    const cover = m.cover ? `<img src="/api/uzel/media/${esc(m.cover)}" alt="" width="58" height="58">` : lucideSvg('music-2');
    const btn = m.audio
      ? `<button class="pl" type="button" data-src="/api/uzel/media/${esc(m.audio)}" aria-label="Play">${lucideSvg('play').replace('<svg', '<svg class="i1"')}${lucideSvg('pause').replace('<svg', '<svg class="i2"')}</button>`
      : `<a class="pl" href="${go('music')}" rel="nofollow noopener ugc" aria-label="Play">${lucideSvg('play')}</a>`;
    music = `<div class="mu g" data-t="${esc(L.now)}"><div class="cv">${cover}</div><div class="mt"><b>${esc(m.title)}</b>${m.artist ? `<span>${esc(m.artist)}</span>` : ''}${waveSvg(m.title)}${m.audio ? '<i class="pb"><b></b></i>' : ''}</div>${btn}</div>`;
  }
  const soc = c.soc ? `<div class="soc" data-t="${esc(L.links)}">${c.soc}</div>` : '';
  const about = page.bio ? `<div class="ab g" data-t="${esc(L.about)}"><h2>${esc(L.about)} ${sp}</h2><p>${esc(page.bio)}</p></div>` : '';
  const ints = (ext.interests || []).length ? `<div class="xit g" data-t="${esc(L.interests)}"><h2>${esc(L.interests)} ${sp}</h2><div class="chips">${ext.interests.map((i) => `<span>${esc(i)}</span>`).join('')}</div></div>` : '';
  const ct = c.infoBtns ? `<div class="ct">${c.infoBtns}</div>` : '';
  const lk = c.links ? `<div class="lk">${c.links}</div>` : '';
  const thanks = ext.thanks ? esc(ext.thanks) : '';
  const loc = ext.location ? `<span class="xloc">${esc(ext.location)}</span>` : '';
  const online = ext.status ? `<span class="xon"><i></i>${esc(ext.status)}</span>` : '';
  const INL = ['neon', 'soft', 'xp'].includes(st);
  const hello = ext.hello || (st === 'planet' ? L.welcome : L.hello);
  const hdr = `<div class="xav" style="background:${c.gradient}">${c.avatar}</div><div class="xid"><p class="xhi">${esc(hello)}</p><h1>${esc(page.name)}${['glass', 'bigname', 'chrome', 'neon'].includes(st) ? sp : ''}</h1>${page.subtitle ? `<p class="xsub">${esc(page.subtitle)}</p>` : ''}${online}${INL ? loc : ''}</div>`;
  const header = st === 'xp' ? `<div class="xhd"><div class="tb"><span>${esc(L.about)}</span><i></i><i></i><i></i></div><div class="xin">${hdr}</div></div>` : `<header class="xh">${INL ? '' : loc}${hdr}</header>`;
  const accent = c.accentCss ? `;${c.accentCss}` : '';
  const style = `--bgi:${bg ? `url(${BASE}/assets/bg/${bg}.webp)` : 'none'};${st === 'bigname' ? `--nf:${nf}px;` : ''}${accent}`;
  const hasAudio = !!(m && m.audio);
  const theme = LIGHT[st] ? '#e8e4da' : '#07070b';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(page.name)} · Узел</title><meta name="description" content="${c.desc}"><meta name="robots" content="noindex,nofollow">
<meta property="og:title" content="${esc(page.name)}"><meta property="og:description" content="${c.desc}"><meta property="og:type" content="profile">${c.img}
<meta name="theme-color" content="${theme}"><link rel="icon" href="${BASE}/assets/favicon.svg" type="image/svg+xml"><style>${STYLE_CSS(BASE)}</style></head>
<body class="x x-${st}${ext.hello ? ' has-hello' : ''}" style="${style}"><div class="bgl"></div><main class="xw">${(DECOR[st] || []).map((d) => SPK(d[0], d[1], d[2], d[3])).join('')}${header}${music}${soc}${about}${ints}${ct}${lk}${c.form}${st === 'planet' || st === 'chrome' ? `<div class="xsc">${lang === 'en' ? 'scroll' : 'ниже'}${lucideSvg('chevron-right')}</div>` : ''}${thanks ? `<p class="xth">${thanks}</p>` : ''}${st === 'soft' || st === 'editorial' ? '<div class="bar"></div>' : ''}<div class="xft">${c.badge}<a href="${c.report}">${c.reportLabel}</a></div></main>${hasAudio ? `<script>${PLAYER_JS}</script>` : ''}</body></html>`;
}

module.exports = { STYLES, BGS, STYLE_BG, PLAYER_HASH, renderStyled };
