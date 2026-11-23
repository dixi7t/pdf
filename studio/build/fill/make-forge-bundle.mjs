import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const LIB = '/home/claude/digitalbazaar/forge/lib';
const entry = ['forge','pkcs12','pkcs7','x509','pki','rsa','sha1','sha256','sha512','md5','des','rc2','aes','pbkdf2','hmac','pbe','asn1','oids','util','random','prng','jsbn','pem','pkcs1','md'];
const mods = new Map(), ext = new Set();
function add(name) {
  if (mods.has(name)) return;
  const src = readFileSync(join(LIB, name + '.js'), 'utf8');
  mods.set(name, src);
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (m[1].startsWith('./')) add(m[1].slice(2).replace(/\.js$/, '')); else ext.add(name + ' -> ' + m[1]);
  }
}
entry.forEach(add);
let out = '/* node-forge (BSD-3-Clause, Digital Bazaar) — subset bundled for PdfCraft: PKCS#12, X.509, PKCS#7 */\n(function(){var M={},C={};function R(n){n=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(C[n])return C[n].exports;var m=C[n]={exports:{}};if(!M[n])return {};M[n].call(m.exports,m,m.exports,R);return m.exports;}\n';
for (const [n, s] of mods) out += `M[${JSON.stringify(n)}]=function(module,exports,require){${s}\n};\n`;
out += 'var f=R("forge");' + entry.map(e=>`R(${JSON.stringify(e)});`).join('') + 'window.forge=f;})();\n';
writeFileSync('forge.bundle.js', out);
console.log(mods.size, 'modules', (out.length/1024).toFixed(0)+'KB'); console.log([...ext].join('\n'));
