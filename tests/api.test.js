import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.js';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
let server, base;
before(async()=>{({server}=createApp({dbPath:':memory:',demo:true}));await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;});
after(()=>new Promise(r=>server.close(r)));
function client(){let cookie='';return async(path,body)=>{const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json','X-CampusLoop-Request':'1'})},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};};}
const login=async(c,role)=>{assert.equal((await c('/login',{email:`${role}@campusloop.test`,password:'CampusLoop123!'})).status,200);};
const register=async(c,email,role='student')=>{assert.equal((await c('/register',{name:'Test user',email,password:'Testing12345!',role})).status,201);};
test('booking/payment/fulfilment/review lifecycle, ownership and analytics',async()=>{
 const student=client(),vendor=client(),admin=client(),other=client();
 await login(student,'student');await login(vendor,'vendor');await login(admin,'admin');await register(other,'other@example.test');
 const services=(await student('/services')).data;assert.equal(services.length,8);
 const order=await student('/orders',{service_id:services[0].id,quantity:2,location:'Block 5',amount:1,commission:0});assert.equal(order.status,201);assert.equal(order.data.amount,9800);const id=order.data.id;
 assert.equal((await vendor(`/orders/${id}/status`,{status:'accepted'})).status,409);
 assert.equal((await other(`/orders/${id}/pay`,{})).status,403);
 assert.equal((await other('/orders')).data.length,0);
 assert.equal((await student(`/orders/${id}/pay`,{})).status,200);
 assert.equal((await student(`/orders/${id}/pay`,{})).status,409);
 assert.equal((await student(`/orders/${id}/status`,{status:'completed'})).status,403);
 assert.equal((await vendor(`/orders/${id}/status`,{status:'completed'})).status,409);
 for(const status of ['accepted','in_progress','ready','completed'])assert.equal((await vendor(`/orders/${id}/status`,{status})).status,200);
 assert.equal((await student(`/orders/${id}/status`,{status:'cancelled'})).status,409);
 assert.equal((await student(`/orders/${id}/review`,{rating:5,comment:'Excellent'})).status,200);
 assert.equal((await student(`/orders/${id}/review`,{rating:5})).status,409);
 const metrics=(await admin('/admin')).data.metrics;assert.equal(metrics.gmv,9800);assert.equal(metrics.commission,980);
 assert.equal((await student('/services')).data[0].rating,5);
 assert.equal((await student('/orders')).data[0].events.length,6);
});
test('registration roles, approval and vendor isolation',async()=>{
 const vendor=client(),admin=client(),attacker=client();
 assert.equal((await attacker('/register',{name:'X',email:'root@example.test',password:'Testing12345!',role:'admin'})).status,400);
 await register(vendor,'newvendor@example.test','vendor');await login(admin,'admin');
 assert.equal((await vendor('/admin')).status,403);
 const listing={title:'New service',category:'laundry',description:'Wash and fold',price:6000,unit:'kg'};
 assert.equal((await vendor('/services',listing)).status,403);
 const id=(await vendor('/me')).data.user.id;assert.equal((await admin(`/vendors/${id}/approve`,{})).status,200);
 assert.equal((await vendor('/services',listing)).status,201);
 assert.equal((await vendor('/orders')).data.length,0);
 assert.equal((await vendor('/orders/1/status',{status:'accepted'})).status,403);
});
test('group quorum, deduplication, discount and group location',async()=>{
 const a=client(),b=client();await register(a,'groupa@example.test');await register(b,'groupb@example.test');
 const g=await a('/groups',{service_id:1,target:2,location:'Shared hostel'});assert.equal(g.status,201);
 assert.equal((await a(`/groups/${g.data.id}/join`,{})).status,409);
 const request={service_id:1,group_id:g.data.id,quantity:1,location:'Fake location'};
 assert.equal((await a('/orders',request)).status,400);
 assert.equal((await b(`/groups/${g.data.id}/join`,{})).status,200);
 const order=await a('/orders',request);assert.equal(order.status,201);assert.equal(order.data.amount,4410);
 assert.equal((await a('/orders')).data[0].location,'Shared hostel');
 assert.equal((await a('/orders',request)).status,409);
});
test('cancelled paid orders receive simulated refund; no commission counted',async()=>{
 const a=client();await register(a,'cancel@example.test');const o=await a('/orders',{service_id:1,quantity:1,location:'Block 1'});
 await a(`/orders/${o.data.id}/pay`,{});assert.equal((await a(`/orders/${o.data.id}/status`,{status:'cancelled'})).status,200);
 assert.equal((await a('/orders')).data[0].payment,'simulated_refunded');
 assert.equal((await a(`/orders/${o.data.id}/pay`,{})).status,409);
});
test('validation, authentication, CSRF header and logout',async()=>{
 for(const [path,content] of [['/','CampusLoop'],['/app.js','async function api'],['/styles.css',':root']]) {
   const response=await fetch(base+path);assert.equal(response.status,200);assert.ok((await response.text()).includes(content));
 }
 const c=client();assert.equal((await c('/orders')).status,401);
 assert.equal((await c('/login',{email:'student@campusloop.test',password:'wrongpassword'})).status,401);
 await login(c,'student');
 for(const quantity of [-1,0,1.5,501,'2'])assert.equal((await c('/orders',{service_id:1,quantity,location:'Block'})).status,400);
 assert.equal((await fetch(base+'/api/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CampusLoop-Request':'1','Origin':'https://evil.test'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/server.js')).status,404);
 assert.equal((await fetch(base+'/data/campusloop.db')).status,404);
 await c('/logout',{});assert.equal((await c('/orders')).status,401);
});
test('database persists orders across application restarts',async()=>{
 const dbPath=join(mkdtempSync(join(tmpdir(),'campusloop-persistence-')),'test.db');
 const first=createApp({dbPath,demo:true});
 first.db.prepare("INSERT INTO orders(student_id,service_id,location,notes,quantity,amount,commission) VALUES(1,1,'Block 5','',1,4900,490)").run();
 first.db.close();
 const second=createApp({dbPath});
 assert.equal(second.db.prepare('SELECT COUNT(*) count FROM orders').get().count,1);
 assert.equal(second.db.prepare('SELECT amount FROM orders').get().amount,4900);
 second.db.close();
});
