#!/usr/bin/env node
// Import a reviewed browser screenshot; this helper never drives a browser or fetches a URL.
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
const [id,view,imagePath]=process.argv.slice(2);
if(!id||!view||!imagePath||!/^[a-z0-9-]+$/.test(id)){console.error('Usage: node preview-thumbnail.mjs <project-id> <view> <screenshot.png|jpg>');process.exit(2)}
const stateDir=process.env.TAILNET_PREVIEW_STATE_DIR||join(process.env.XDG_STATE_HOME||join(homedir(),'.local','state'),'tailnet-preview');
const registry=JSON.parse(await readFile(join(stateDir,'registry.json'),'utf8'));
const project=registry.projects?.[id];if(!project?.views?.[view])throw new Error('That project view is not registered.');
const image=await readFile(resolve(imagePath));if(image.length>2*1024*1024)throw new Error('Screenshot exceeds the 2 MB limit.');
const png=image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const jpeg=image[0]===255&&image[1]===216&&image[2]===255;
if(!png&&!jpeg)throw new Error('Use a PNG or JPEG browser screenshot.');
const dir=join(stateDir,'thumbnails');await mkdir(dir,{recursive:true,mode:0o700});const file=join(dir,`${id}.json`),temporary=`${file}.${process.pid}.tmp`;
await writeFile(temporary,JSON.stringify({version:1,view,route:project.views[view],capturedAt:new Date().toISOString(),dataUrl:`data:image/${png?'png':'jpeg'};base64,${image.toString('base64')}`}),{mode:0o600});await rename(temporary,file);console.log(JSON.stringify({ok:true,id,view,bytes:image.length}));
