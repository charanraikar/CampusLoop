import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.js';
let server,base;
before(async()=>{({server}=createApp({dbPath:':memory:',demo:true}));await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;});
after(()=>new Promise(r=>server.close(r)));
function client(){let cookie='';return async(path,body)=>{
  const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json','X-CampusLoop-Request':'1'})},body:body===undefined?undefined:JSON.stringify(body)});
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
  return {status:r.status,data:r.headers.get('content-type').includes('application/json')?await r.json():await r.text(),headers:r.headers};
};}
async function login(c,role){assert.equal((await c('/login',{email:`${role}@campusloop.test`,password:'CampusLoop123!'})).status,200);}
test('health endpoint and protected PDF/receipt workflow',async()=>{
 const student=client(),vendor=client(),stranger=client();await login(student,'student');await login(vendor,'vendor');
 await stranger('/register',{name:'Other',email:'otherfile@example.test',password:'Other123456!',role:'student'});
 assert.equal((await student('/health')).data.status,'ok');
 const order=(await student('/orders',{service_id:2,quantity:10,location:'Print shop'})).data.id;
 const path=`/orders/${order}/attachment`;
 const pdf={filename:'example.pdf',base64:Buffer.from('%PDF-1.4\n%minimal-test-fixture\n%%EOF').toString('base64')};
 assert.equal((await stranger(path,pdf)).status,403);
 assert.equal((await vendor(path,pdf)).status,403);
 assert.equal((await student(path,{...pdf,base64:Buffer.from('<script>bad</script>').toString('base64')})).status,400);
 assert.equal((await student(path,{...pdf,filename:'bad.html'})).status,400);
 assert.equal((await student(path,pdf)).status,200);
 assert.equal((await vendor(path)).status,200);
 assert.equal((await stranger(path)).status,403);
 assert.equal((await student('/orders')).data[0].filename,'example.pdf');
 const receipt=await student(`/orders/${order}/receipt`);assert.equal(receipt.status,200);assert.match(receipt.data,/INR 20.00/);assert.match(receipt.data,/SIMULATED/);
 assert.equal((await stranger(`/orders/${order}/receipt`)).status,403);
 await student(`/orders/${order}/pay`,{});await vendor(`/orders/${order}/status`,{status:'accepted'});
 assert.equal((await student(path,pdf)).status,409);
});
test('vendor rejection requires a reason and refunds a simulated payment',async()=>{
 const s=client(),v=client();await login(s,'student');await login(v,'vendor');
 const id=(await s('/orders',{service_id:1,quantity:1,location:'Block 3'})).data.id;
 await s(`/orders/${id}/pay`,{});
 assert.equal((await v(`/orders/${id}/status`,{status:'rejected'})).status,400);
 assert.equal((await v(`/orders/${id}/status`,{status:'rejected',reason:'No pickup slots available'})).status,200);
 const o=(await s('/orders')).data.find(o=>o.id===id);assert.equal(o.payment,'simulated_refunded');assert.equal(o.status,'rejected');
 assert.match(o.events.at(-1).action,/No pickup slots/);
 assert.equal((await s(`/orders/${id}/pay`,{})).status,409);
});
test('password change verifies old password and revokes other sessions',async()=>{
 const first=client(),second=client();await login(first,'student');await login(second,'student');
 assert.equal((await first('/password',{current_password:'WrongPassword',new_password:'NewPassword123!'})).status,403);
 assert.equal((await first('/password',{current_password:'CampusLoop123!',new_password:'NewPassword123!'})).status,200);
 assert.equal((await first('/orders')).status,200);assert.equal((await second('/orders')).status,401);
 assert.equal((await second('/login',{email:'student@campusloop.test',password:'CampusLoop123!'})).status,401);
 assert.equal((await second('/login',{email:'student@campusloop.test',password:'NewPassword123!'})).status,200);
});
test('private bootstrap creates admin without public demo users',()=>{
 const app=createApp({dbPath:':memory:',adminEmail:'admin@example.test',adminPassword:'PrivatePassword123!'});
 assert.equal(app.db.prepare('SELECT COUNT(*) n FROM users').get().n,1);
 assert.equal(app.db.prepare('SELECT role FROM users').get().role,'admin');app.db.close();
});
