const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1160,height:300}});
const f=['logo','about','services','work','reviews','offers','contact','faq'];
require('fs').writeFileSync(__dirname+'/p.html','<body style="margin:0;background:#fff;display:flex;gap:20px;padding:20px">'+f.map(n=>`<img src="file://${__dirname}/${n}.png" style="width:120px;height:120px;border-radius:50%;border:2px solid #ccc">`).join('')+'</body>');
await p.goto('file://'+__dirname+'/p.html');await p.waitForTimeout(300);await p.screenshot({path:'preview.png',clip:{x:0,y:0,width:1160,height:170}});await b.close()})();
