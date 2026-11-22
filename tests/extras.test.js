import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.js';

const apiCalls=[];
const fakeFetch=async(url,opts)=>{apiCalls.push({url,opts,body:JSON.parse(opts.body)});return {ok:true,status:201,json:async()=>({})};};
let server, base;
before(async()=>{({server}=createApp({dbPath:':memory:',demo:true,brevoApiKey:'xkeysib-test',brevoSenderEmail:'sender@example.test',brevoSenderName:'CampusLoop Test',resendApiKey:'re_should_not_be_used',fetchImpl:fakeFetch}));await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;});
after(()=>new Promise(r=>server.close(r)));
function client(){let cookie='';const call=async(path,body)=>{const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json','X-CampusLoop-Request':'1'})},body:body===undefined?undefined:JSON.stringify(body)});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];return {status:r.status,data:await r.json()};};call.raw=path=>fetch(base+'/api'+path,{headers:{cookie}});return call;}
const login=async(c,role)=>assert.equal((await c('/login',{email:`${role}@campusloop.test`,password:'CampusLoop123!'})).status,200);

test('Brevo is used for email when configured (and preferred over Resend)',async()=>{
  const c=client();assert.equal((await c('/me')).data.mail,true);
  assert.equal((await c('/forgot',{email:'student@campusloop.test'})).status,200);
  const call=apiCalls.at(-1);
  assert.equal(call.url,'https://api.brevo.com/v3/smtp/email');
  assert.equal(call.opts.headers['api-key'],'xkeysib-test');
  assert.deepEqual(call.body.sender,{name:'CampusLoop Test',email:'sender@example.test'});
  assert.deepEqual(call.body.to,[{email:'student@campusloop.test'}]);
  assert.match(call.body.textContent,/#reset=[a-f0-9]+/);
});

test('Brevo key without a sender address does not count as configured',async()=>{
  const {server:s2}=createApp({dbPath:':memory:',demo:true,brevoApiKey:'xkeysib-test',fetchImpl:fakeFetch});
  await new Promise(r=>s2.listen(0,'127.0.0.1',r));
  const r=await fetch(`http://127.0.0.1:${s2.address().port}/api/me`);assert.equal((await r.json()).mail,false);
  await new Promise(r=>s2.close(r));
});

test('vendor WhatsApp number: validated, normalised, shown to students',async()=>{
  const vendor=client(),student=client(),pub=client();await login(vendor,'vendor');await login(student,'student');
  for(const bad of ['abc','123','98765x4321','1234567890123456'])assert.equal((await vendor('/profile',{bio:'',hours:'',area:'',whatsapp:bad})).status,400,bad);
  assert.equal((await vendor('/profile',{bio:'b',hours:'h',area:'a',whatsapp:'98765 43210'})).data.whatsapp,'919876543210');
  assert.equal((await vendor('/profile',{whatsapp:'+91 98765-43210'})).data.whatsapp,'919876543210');
  const svc=(await pub('/services')).data[0];
  assert.equal((await pub(`/vendors/${svc.vendor_id}`)).data.whatsapp,'919876543210');
  const o=await student('/orders',{service_id:svc.id,quantity:1,location:'B1'});assert.equal(o.status,201);
  assert.equal((await student('/orders')).data.find(x=>x.id===o.data.id).vendor_whatsapp,'919876543210');
  assert.equal((await vendor('/profile',{whatsapp:''})).data.whatsapp,'','blank removes the number');
  assert.equal((await pub(`/vendors/${svc.vendor_id}`)).data.whatsapp,'');
});

test('earnings CSV: totals, date filter, formula-injection protection, access control',async()=>{
  const vendor=client(),student=client();await login(vendor,'vendor');await login(student,'student');
  const sv=await vendor('/services',{title:'=HYPERLINK("http://x")',category:'laundry',price:5000,unit:'kg',description:'test'});assert.equal(sv.status,201);
  const o=await student('/orders',{service_id:sv.data.id,quantity:2,location:'B1'});assert.equal(o.status,201);
  assert.equal((await student(`/orders/${o.data.id}/pay`,{})).status,200);
  for(const status of ['accepted','in_progress','ready','completed'])assert.equal((await vendor(`/orders/${o.data.id}/status`,{status})).status,200);
  const res=await vendor.raw('/vendor/earnings.csv');assert.equal(res.status,200);
  assert.match(res.headers.get('content-type'),/^text\/csv/);assert.match(res.headers.get('content-disposition'),/attachment; filename="campusloop-earnings-\d{4}-\d{2}-\d{2}\.csv"/);
  const buf=Buffer.from(await res.arrayBuffer());assert.deepEqual([...buf.subarray(0,3)],[0xEF,0xBB,0xBF],'UTF-8 BOM so Excel shows symbols correctly');const text=buf.toString('utf8').replace(/^\ufeff/,'');assert.ok(text.startsWith('Order ID,'));
  assert.ok(text.includes(`"'=HYPERLINK(""http://x"")"`),'formulas are neutralised');
  const lines=text.trim().split('\r\n');assert.ok(lines.at(-1).startsWith('TOTAL,'));
  assert.ok(lines.some(l=>l.startsWith(`${o.data.id},`)&&l.includes('100.00,10.00,90.00')),'gross, fee, net columns');
  const none=(await (await vendor.raw('/vendor/earnings.csv?from=2999-01-01')).text()).trim().split('\r\n');assert.equal(none.length,2,'header + total only');
  assert.equal((await vendor.raw('/vendor/earnings.csv?from=nonsense')).status,400);
  assert.equal((await student.raw('/vendor/earnings.csv')).status,403);
});
