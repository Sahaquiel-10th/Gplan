// Untrusted document rendering and archive expansion run outside the web process.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const MAX_FILES=500, MAX_BYTES=250*1024*1024, MAX_FILE=100*1024*1024;
const safe=name=>{const n=name.replace(/\\/g,'/');if(!n||n.length>500||n.startsWith('/')||/^[a-z]:/i.test(n)||/[\x00-\x1f\x7f]/.test(n)||n.split('/').some(p=>p==='..'||p==='.'))throw Error('压缩包包含不安全路径');return n;};
const xmlText=s=>s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(Number(n),0x10ffff))).replace(/[ \t]+/g,' ').trim();

async function archive(file,out) {
  const {default:SevenZip}=await import('7z-wasm');let log=[];
  const z=await SevenZip({print:s=>{if(log.length<30000)log.push(String(s));},printErr:()=>{}});
  const ext=path.extname(file)||'.zip',name='/input'+ext;
  z.FS.writeFile(name,new Uint8Array(await fs.readFile(file)));
  if(z.callMain(['l','-slt','-ba','-p__NO_PASSWORD__',name])!==0)throw Error('无法打开压缩包，可能已加密、损坏或缺少分卷');
  const blocks=log.join('\n').split(/\n\s*\n/).filter(b=>/^Path = /m.test(b));
  if(blocks.length>MAX_FILES+500)throw Error('压缩包目录过多，请拆分上传');
  let total=0,count=0;
  for(const block of blocks){safe(block.match(/^Path = (.*)$/m)[1]);if(/Symbolic Link =|Hard Link =|Reparse|^Attributes = .*l[rwx-]/m.test(block))throw Error('压缩包不能包含链接');const size=Number(block.match(/^Size = (\d+)/m)?.[1]||0);total+=size;if(size>MAX_FILE||total>MAX_BYTES)throw Error('压缩包展开后过大，请拆分上传');if(!/^Folder = \+/m.test(block)&&!/^Attributes = D/m.test(block))count++;}
  if(count>MAX_FILES)throw Error('压缩包最多包含500个文件');
  log=[];z.FS.mkdir('/out');
  if(z.callMain(['x',name,'-o/out','-y','-p__NO_PASSWORD__','-bb0'])!==0)throw Error('压缩包解压失败，可能已加密、损坏或缺少分卷');
  const files=[];let bytes=0;
  const walk=async(dir,prefix)=>{for(const n of z.FS.readdir(dir)){if(n==='.'||n==='..')continue;const relative=safe(prefix+n),p=dir+'/'+n,stat=z.FS.lstat(p);if(z.FS.isLink(stat.mode))throw Error('压缩包不能包含链接');if(z.FS.isDir(stat.mode)){await walk(p,relative+'/');continue;}if(!z.FS.isFile(stat.mode))throw Error('压缩包包含特殊文件');if(relative.split('/').some(v=>v==='__MACOSX'||v==='.DS_Store'||v.startsWith('._')))continue;bytes+=stat.size;if(files.length>=MAX_FILES||stat.size>MAX_FILE||bytes>MAX_BYTES)throw Error('压缩包展开后超过文件数量或大小限制');const dest=path.join(out,`entry-${files.length}${path.extname(relative).replace(/[^.a-z0-9]/ig,'').slice(0,16)||'.bin'}`);await fs.writeFile(dest,z.FS.readFile(p));files.push({name:relative,path:dest,size:stat.size});}};
  await walk('/out','');if(!files.length)throw Error('压缩包内没有可处理的文件');return {files};
}
async function document(file,out,ext) {
  const data=await fs.readFile(file),units=[];let written=0;
  const writeImage=async(p,bytes)=>{written+=bytes.length;if(written>MAX_BYTES)throw Error('渲染后的图片超过250MB，请拆分后上传');await fs.writeFile(p,bytes);};
  if(ext==='.pdf'){
    const canvas=await import('@napi-rs/canvas');globalThis.DOMMatrix??=canvas.DOMMatrix;globalThis.Path2D??=canvas.Path2D;globalThis.ImageData??=canvas.ImageData;
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const root=path.dirname(require.resolve('pdfjs-dist/package.json'));
    const task=pdfjs.getDocument({data:new Uint8Array(data),isEvalSupported:false,useWorkerFetch:false,useSystemFonts:false,standardFontDataUrl:root+'/standard_fonts/',cMapUrl:root+'/cmaps/',cMapPacked:true,verbosity:0});
    const pdf=await task.promise;
    try {
      if(pdf.numPages>100)throw Error('单份PDF最多100页，请拆分后上传');
      for(let p=1;p<=pdf.numPages;p++){
        const page=await pdf.getPage(p),content=await page.getTextContent();
        const text=content.items.map(x=>x.str?(x.str+(x.hasEOL?'\n':' ')):'').join('').trim();
        // A full page raster also preserves labels/coordinates that a text layer loses.
        const base=page.getViewport({scale:1});const scale=Math.min(2.5,2400/Math.max(base.width,base.height));
        const viewport=page.getViewport({scale}),c=canvas.createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
        await page.render({canvasContext:c.getContext('2d'),viewport}).promise;
        const imagePath=path.join(out,`page-${p}.png`);await writeImage(imagePath,c.toBuffer('image/png'));
        units.push({page:p,text:text.slice(0,20000),imagePath});page.cleanup();
      }
    } finally {await pdf.destroy();}
  } else if(ext==='.ofd') {
    const {default:JSZip}=await import('jszip');const zip=await JSZip.loadAsync(data);const entries=Object.values(zip.files);
    if(entries.length>5000||entries.reduce((n,f)=>n+Number(f._data?.uncompressedSize||0),0)>MAX_BYTES)throw Error('OFD内部数据过大');
    const pages=entries.filter(f=>/Pages\/Page_?\d+\/Content.xml$/i.test(f.name)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
    if(pages.length>100)throw Error('单份OFD最多100页');
    for(const [i,f] of pages.entries()){const text=await f.async('string');if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('OFD包含不支持的XML声明');const values=[...text.matchAll(/<(?:\w+:)?TextCode\b[^>]*>([\s\S]*?)<\/(?:\w+:)?TextCode>/g)].map(m=>xmlText(m[1]));const body=values.join('\n');if(!body)throw Error('该OFD没有可读取的文本，请导出为PDF或图片后上传');units.push({page:i+1,text:body.slice(0,25000)});}
    if(!units.length)throw Error('OFD没有可读取的页面，请导出为PDF后上传');
  } else if(['.png','.jpg','.jpeg','.webp','.gif','.bmp','.tif','.tiff','.heic','.heif','.avif'].includes(ext)){
    const {default:sharp}=await import('sharp');let input=data;
    if(ext==='.bmp'){if(data.length<26||Math.abs(data.readInt32LE(18))*Math.abs(data.readInt32LE(22))>50000000)throw Error('BMP图片尺寸过大或格式无效');const {default:bmp}=await import('bmp-js');const decoded=bmp.decode(data),rgb=Buffer.alloc(decoded.width*decoded.height*3);for(let i=0,j=0;i<decoded.data.length;i+=4){rgb[j++]=decoded.data[i+3];rgb[j++]=decoded.data[i+2];rgb[j++]=decoded.data[i+1];}input=await sharp(rgb,{raw:{width:decoded.width,height:decoded.height,channels:3}}).png().toBuffer();}
    if(ext==='.heic'||ext==='.heif'){
      const {default:decode}=await import('heic-decode');const images=await decode.all({buffer:data});
      try{if(images.length>100)throw Error('HEIC图片页数超过100');for(const [i,image] of images.entries()){const d=await image.decode();if(d.width*d.height>50000000)throw Error('图片像素过大');const imagePath=path.join(out,`page-${i+1}.png`);await writeImage(imagePath,await sharp(Buffer.from(d.data),{raw:{width:d.width,height:d.height,channels:4}}).resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).flatten({background:'#fff'}).png().toBuffer());units.push({page:i+1,text:'',imagePath});}}finally{images.dispose();}return {units};
    }
    const meta=await sharp(input,{limitInputPixels:50000000}).metadata();const pages=meta.pages||1;if(pages>100)throw Error('单个图片文件最多100页/帧');
    for(let i=0;i<pages;i++){const imagePath=path.join(out,`page-${i+1}.png`);await writeImage(imagePath,await sharp(input,{page:i,pages:1,limitInputPixels:50000000}).rotate().resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).flatten({background:'#fff'}).png().toBuffer());units.push({page:i+1,text:'',imagePath});}
  } else if(['.xml','.txt'].includes(ext)){
    let text=new TextDecoder(data[0]===255&&data[1]===254?'utf-16le':'utf-8').decode(data);
    if(ext==='.xml'){if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('不支持带外部实体声明的XML');text=text.replace(/<([\w:]+)[^>]*>([^<>]+)<\/\1>/g,(_,tag,v)=>`\n${tag}: ${v}\n`);text=xmlText(text);}
    if(!text.trim()||text.length>100000)throw Error('文件文本为空或过长');units.push({page:1,text:text.slice(0,30000)});
  } else if(['.docx','.xlsx','.xls','.csv'].includes(ext)) {
    let text='';
    if(ext==='.docx'){const {default:mammoth}=await import('mammoth');text=(await mammoth.extractRawText({buffer:data})).value;}
    else {const XLSX=await import('xlsx');const wb=XLSX.read(data,{type:'buffer'});text=wb.SheetNames.map(n=>`工作表${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n');}
    if(!text.trim()||text.length>100000)throw Error('文件内容为空或过长，请拆分后上传');units.push({page:1,text:text.slice(0,30000)});
  } else throw Error('暂不支持此文件格式，请导出为PDF、OFD、XML或清晰图片');
  return {units};
}
process.once('message',async message=>{
  try{await fs.mkdir(message.out,{recursive:true});const result=message.action==='archive'?await archive(message.file,message.out):await document(message.file,message.out,message.ext);process.send?.({ok:true,...result},()=>process.exit(0));}
  catch(error){process.send?.({ok:false,error:/password/i.test(String(error))?'文件已加密，请先解除密码后上传':String(error.message||error).slice(0,300)},()=>process.exit(0));}
});
