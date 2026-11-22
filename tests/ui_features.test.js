import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.js';

let server, base;
before(async()=>{({server}=createApp({dbPath:':memory:',demo:true,mailSink:()=>{}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;});
after(()=>new Promise(r=>server.close(r)));
function client(){let cookie='';return async(path,body)=>{const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json','X-CampusLoop-Request':'1'})},body:body===undefined?undefined:JSON.stringify(body)});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];return {status:r.status,data:await r.json()};};}
const login=async(c,role)=>assert.equal((await c('/login',{email:`${role}@campusloop.test`,password:'CampusLoop123!'})).status,200);

test('favourites: toggle per user, validation and login required',async()=>{
  const pub=client(),s1=client(),s2=client();await login(s1,'student');await login(s2,'vendor');
  const svc=(await pub('/services')).data;
  assert.equal((await pub('/favorites')).status,401);assert.equal((await pub(`/favorites/${svc[0].id}`,{})).status,401);
  assert.deepEqual((await s1('/favorites')).data,[]);
  assert.equal((await s1(`/favorites/${svc[0].id}`,{})).data.favorite,true);
  assert.equal((await s1(`/favorites/${svc[2].id}`,{})).data.favorite,true);
  assert.deepEqual((await s1('/favorites')).data.sort(),[svc[0].id,svc[2].id].sort());
  assert.deepEqual((await s2('/favorites')).data,[],'favourites are private');
  assert.equal((await s1(`/favorites/${svc[0].id}`,{})).data.favorite,false,'second click removes it');
  assert.equal((await s1('/favorites/99999',{})).status,404);
});

test('services expose review counts for the star display',async()=>{
  const svc=(await client()('/services')).data;assert.ok(svc.every(s=>Number.isInteger(s.reviews)));
});

test('in-app notifications: created on order events, private, mark read',async()=>{
  const student=client(),vendor=client();await login(student,'student');await login(vendor,'vendor');
  const svc=(await student('/services')).data[0];
  assert.equal((await client()('/notifications')).status,401);
  const v0=(await vendor('/notifications')).data.unread,s0=(await student('/notifications')).data.unread;
  const o=await student('/orders',{service_id:svc.id,quantity:1,location:'B1'});await student(`/orders/${o.data.id}/pay`,{});
  const v1=(await vendor('/notifications')).data;assert.equal(v1.unread,v0+1);assert.match(v1.items[0].title,/New paid order/);
  await vendor(`/orders/${o.data.id}/status`,{status:'accepted'});await vendor(`/orders/${o.data.id}/status`,{status:'in_progress'});await vendor(`/orders/${o.data.id}/status`,{status:'ready'});
  const s1=(await student('/notifications')).data;assert.equal(s1.unread,s0+3);assert.match(s1.items[0].body,/READY/);
  assert.equal(s1.items.some(i=>/New paid order/.test(i.title)),false,'students do not see vendor notifications');
  assert.equal((await student('/notifications/read',{})).status,200);
  assert.equal((await student('/notifications')).data.unread,0);assert.equal((await vendor('/notifications')).data.unread,v0+1,'marking read only affects your own');
  await student(`/orders/${o.data.id}/messages`,{body:'Thanks!'});
  assert.match((await vendor('/notifications')).data.items[0].title,/New message/);
});

test('admin chart data: shape and access control',async()=>{
  const admin=client(),student=client();await login(admin,'admin');await login(student,'student');
  const svc=(await student('/services')).data[0];await student('/orders',{service_id:svc.id,quantity:1,location:'B1'});
  const ch=(await admin('/admin/charts')).data;
  assert.ok(Array.isArray(ch.perDay)&&ch.perDay.length>=1&&ch.perDay[0].orders>=1);
  assert.ok(ch.byStatus.some(r=>r.status==='pending'));assert.ok(ch.byCategory.length>=1&&typeof ch.byCategory[0].category==='string');
  assert.equal((await student('/admin/charts')).status,403);assert.equal((await client()('/admin/charts')).status,401);
});
