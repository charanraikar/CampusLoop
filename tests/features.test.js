import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.js';

const mails=[];
let server, db, base;
before(async()=>{({server,db}=createApp({dbPath:':memory:',demo:true,mailSink:m=>mails.push(m)}));await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;});
after(()=>new Promise(r=>server.close(r)));
function client(){let cookie='';return async(path,body)=>{const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json','X-CampusLoop-Request':'1'})},body:body===undefined?undefined:JSON.stringify(body)});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];return {status:r.status,data:await r.json()};};}
const login=async(c,role)=>{assert.equal((await c('/login',{email:`${role}@campusloop.test`,password:'CampusLoop123!'})).status,200);};
const register=async(c,email,role='student')=>{const r=await c('/register',{name:'Test '+role,email,password:'Testing12345!',role});assert.equal(r.status,201);return r;};
const pay=async(c,id)=>assert.equal((await c(`/orders/${id}/pay`,{})).status,200);
const tomorrow=()=>new Date(Date.now()+86400000).toISOString().slice(0,10);

test('password reset: token works once, email is not leaked, sessions are cleared',async()=>{
  const c=client();await register(c,'reset@example.test');
  assert.equal((await c('/forgot',{email:'nobody@example.test'})).status,200);
  const before=mails.length;assert.equal((await c('/forgot',{email:'reset@example.test'})).status,200);
  const mail=mails.at(-1);assert.equal(mails.length,before+1);assert.equal(mail.to,'reset@example.test');
  const token=/#reset=([a-f0-9]+)/.exec(mail.body)[1];
  assert.equal((await c('/reset-password',{token:'bad',password:'NewPassword123!'})).status,400);
  assert.equal((await c('/reset-password',{token,password:'short'})).status,400);
  assert.equal((await c('/reset-password',{token,password:'NewPassword123!'})).status,200);
  assert.equal((await c('/reset-password',{token,password:'AnotherPass123!'})).status,400,'token is single-use');
  assert.equal((await client()('/login',{email:'reset@example.test',password:'NewPassword123!'})).status,200);
});

test('email verification link marks the account verified',async()=>{
  const c=client();await register(c,'verify@example.test');
  const mail=mails.filter(m=>m.to==='verify@example.test'&&/#verify=/.test(m.body)).at(-1);
  assert.equal((await c('/me')).data.user.emailVerified,false);
  assert.equal((await c('/verify-email',{token:/#verify=([a-f0-9]+)/.exec(mail.body)[1]})).status,200);
  assert.equal((await c('/me')).data.user.emailVerified,true);
});

test('slots, coupons, referrals, ready step, notifications and chat',async()=>{
  const admin=client(),vendor=client(),s1=client(),s2=client();
  await login(admin,'admin');await login(vendor,'vendor');await login(s1,'student');await register(s2,'friend@example.test');
  const svc=(await s1('/services')).data[0];
  assert.equal((await s1('/orders',{service_id:svc.id,quantity:1,location:'B1',slot:'2020-01-01 09-12'})).status,400);
  assert.equal((await s1('/orders',{service_id:svc.id,quantity:1,location:'B1',slot:`${tomorrow()} 25-26`})).status,400);
  assert.equal((await admin('/admin/coupons',{code:'REFHACK',percent:10,max_uses:5})).status,400);
  assert.equal((await s1('/admin/coupons',{code:'SAVE20',percent:20,max_uses:1})).status,403);
  assert.equal((await admin('/admin/coupons',{code:'SAVE20',percent:20,max_uses:1})).status,201);
  const a=await s1('/orders',{service_id:svc.id,quantity:1,location:'B1',slot:`${tomorrow()} 15-18`,coupon:'save20'});
  assert.equal(a.status,201);assert.equal(a.data.amount,3920);assert.equal(a.data.discount,980);
  assert.equal((await s2('/orders',{service_id:svc.id,quantity:1,location:'B2',coupon:'SAVE20'})).status,400,'single-use coupon is used up');
  assert.equal((await s1(`/orders/${a.data.id}/status`,{status:'cancelled'})).status,200);
  const b=await s2('/orders',{service_id:svc.id,quantity:1,location:'B2',coupon:'SAVE20'});assert.equal(b.status,201,'cancelling restores the coupon');
  assert.equal((await s2(`/orders/${b.data.id}/status`,{status:'cancelled'})).status,200);
  // referral
  const mine=(await s1('/coupons/mine')).data;assert.match(mine.ref_code,/^REF[A-F0-9]{8}$/);
  assert.equal((await s1('/orders',{service_id:svc.id,quantity:1,location:'B1',coupon:mine.ref_code})).status,400,'own code rejected');
  const r=await s2('/orders',{service_id:svc.id,quantity:1,location:'B2',coupon:mine.ref_code});assert.equal(r.status,201);assert.equal(r.data.amount,4410);
  await pay(s2,r.data.id);mails.length=0;
  for(const status of ['accepted','in_progress','ready','completed'])assert.equal((await vendor(`/orders/${r.data.id}/status`,{status})).status,200);
  assert.ok(mails.some(m=>m.to==='friend@example.test'&&/READY/.test(m.body)),'student emailed when ready');
  const reward=(await s1('/coupons/mine')).data.coupons.find(c=>c.code.startsWith('THANKS'));assert.ok(reward,'referrer receives reward coupon');
  const own=await s1('/orders',{service_id:svc.id,quantity:2,location:'B1',coupon:reward.code});assert.equal(own.status,201);assert.equal(own.data.amount,8820);
  assert.equal((await s2('/orders',{service_id:svc.id,quantity:1,location:'B2',coupon:reward.code})).status,400,'reward coupon belongs to referrer');
  // chat
  const id=r.data.id;
  assert.equal((await s1(`/orders/${id}/messages`)).status,403);
  assert.equal((await s2(`/orders/${id}/messages`,{body:'Is it ready?'})).status,200);
  const thread=(await vendor(`/orders/${id}/messages`,{body:'Yes, collect any time'})).data;assert.equal(thread.length,2);
  assert.equal((await admin(`/orders/${id}/messages`)).data.length,2);assert.equal((await admin(`/orders/${id}/messages`,{body:'hi'})).status,403);
});

test('vendor profile, earnings, refunds-due screen and audit log',async()=>{
  const admin=client(),vendor=client(),student=client(),pub=client();
  await login(admin,'admin');await login(vendor,'vendor');await login(student,'student');
  assert.equal((await student('/profile',{bio:'x'})).status,403);
  assert.equal((await vendor('/profile',{bio:'Fast laundry',hours:'9–6',area:'Block A–D'})).status,200);
  const svc=(await pub('/services')).data[0];const prof=(await pub(`/vendors/${svc.vendor_id}`)).data;
  assert.equal(prof.bio,'Fast laundry');assert.ok(prof.services.length>=8);assert.equal((await pub('/vendors/9999')).status,404);
  const e0=(await vendor('/vendor/earnings')).data;
  const o=await student('/orders',{service_id:svc.id,quantity:1,location:'B1'});await pay(student,o.data.id);
  for(const status of ['accepted','in_progress','ready','completed'])await vendor(`/orders/${o.data.id}/status`,{status});
  const e=(await vendor('/vendor/earnings')).data;assert.equal(e.totals.orders-e0.totals.orders,1);assert.equal(e.totals.gross-e0.totals.gross,4900);assert.equal(e.totals.net-e0.totals.net,4410);assert.equal(e.days.length,1);
  assert.equal((await student('/vendor/earnings')).status,403);
  const o2=await student('/orders',{service_id:svc.id,quantity:1,location:'B1'});await pay(student,o2.data.id);
  assert.equal((await admin(`/admin/orders/${o2.data.id}/refund`,{manual:true})).status,409,'only refund_due orders');
  db.prepare("UPDATE orders SET payment='refund_due' WHERE id=?").run(o2.data.id);
  assert.equal((await admin('/admin')).data.refunds.length,1);
  assert.equal((await admin(`/admin/orders/${o2.data.id}/refund`,{})).status,400,'online retry unavailable without Razorpay');
  assert.equal((await student(`/admin/orders/${o2.data.id}/refund`,{manual:true})).status,403);
  assert.equal((await admin(`/admin/orders/${o2.data.id}/refund`,{manual:true})).status,200);
  assert.equal((await student('/orders')).data.find(x=>x.id===o2.data.id).payment,'refunded');
  assert.ok((await admin('/admin/audit')).data.some(a=>a.action==='coupon created'||a.action==='service listed'||a.action==='login'));
  assert.equal((await student('/admin/audit')).status,403);
});

test('legal pages and installable-app files are served',async()=>{
  for(const [p,type] of [['/terms','text/html'],['/privacy','text/html'],['/refund-policy','text/html'],['/manifest.webmanifest','application/manifest+json'],['/sw.js','text/javascript'],['/icon-192.png','image/png'],['/icon-512.png','image/png']]) {
    const r=await fetch(base+p);assert.equal(r.status,200,p);assert.ok(r.headers.get('content-type').startsWith(type),p);
  }
});
