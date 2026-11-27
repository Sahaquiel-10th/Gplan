// Public, credential-free check after the normal authenticated deployment checks.
import assert from "node:assert/strict";
const base = new URL("https://ai.miwuj.cn/");
async function verify() {
  const page = await fetch(base,{cache:"no-store",signal:AbortSignal.timeout(12000)});
  assert.equal(page.status,200);
  const html = await page.text();
  const scripts = Array.from(html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js)["']/g),m=>new URL(m[1],base)).filter(url=>url.origin===base.origin);
  let found=false;
  for(const url of scripts) {
    const response=await fetch(url,{signal:AbortSignal.timeout(12000)});
    if(response.ok && (await response.text()).includes("retrievalPreview")) found=true;
  }
  assert.ok(found,"Production bundle does not contain admin preview");
  const denied=await fetch(new URL("/api/chat",base),{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({retrievalPreview:true}),signal:AbortSignal.timeout(12000)});
  assert.equal(denied.status,401,"Anonymous preview request should require login");
}
for(let attempt=1;;attempt++){
  try{await verify();console.log("Production composer bundle and anonymous access check passed.");break;}
  catch(error){if(attempt===4)throw error;await new Promise(r=>setTimeout(r,3000));}
}
