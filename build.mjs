import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=new URL('./',import.meta.url);
const css=await readFile(new URL('source/shared.css',root),'utf8');
const viewerCss=await readFile(new URL('source/viewer.css',root),'utf8');
const js=await readFile(new URL('source/shared.js',root),'utf8');
for(const page of ['dashboard','viewer']){
 const source=await readFile(new URL(`source/${page}.html`,root),'utf8');
 await writeFile(new URL(`assets/${page}.html`,root),source.replace('__SHARED_CSS__',()=>css).replace('__SHARED_JS__',()=>js).replace('__VIEWER_CSS__',()=>viewerCss));
}
console.log('Built dashboard and viewer.');
