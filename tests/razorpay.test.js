import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createApp} from '../server.js';

const KEY_ID='rzp_test_abc', SECRET='test_secret', HOOK='hook_secret';
const calls=[];
const fakeRazorpay=async(url,opts)=>{
  calls.push({url,body:JSON.parse(opts.body),auth:opts.headers.Authorization});
  if(url.endsWith('/orders')) return {ok:true,json:async()=>({id:'order_TEST'+calls.length})};
  if(url.includes('/refund')) return {ok:true,json:async()=>({id:'rfnd_1'})};
  return {ok:false,status:400,json:async()=>({})};
};
let server, base;
before(async()=>{({server}=createApp({dbPath:':memory:',demo:true,razorpayKeyId:KEY_ID,razorpayKeySecret:SECRET,razorpayWebhookSecret:HOOK,fetchImpl:fakeRazorpay}));await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;});
after(()=>new Promise(r=>server.close(r)));
function client(){let cookie='';return async(path,body)=>{const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'Content-Type':'application/json','X-CampusLoop-Request':'1'})},body:body===undefined?undefined:JSON.stringify(body)});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];return {status:r.status,data:await r.json()};};}
const login=async(c,role)=>{assert.equal((await c('/login',{email:`${role}@campusloop.test`,password:'CampusLoop123!'})).status,200);};
const sign=(orderId,paymentId)=>createHmac('sha256',SECRET).update(`${orderId}|${paymentId}`).digest('hex');
async function newOrder(student){const services=(await student('/services')).data;const o=await student('/orders',{service_id:services[0].id,quantity:1,location:'Block 2'});assert.equal(o.status,201);return o.data.id;}

test('live mode: order is created at Razorpay, signature verified, then vendor can proceed',async()=>{
  const student=client(),vendor=client();await login(student,'student');await login(vendor,'vendor');
  assert.equal((await student('/me')).data.payments,'razorpay');
  const id=await newOrder(student);
  const pay=await student(`/orders/${id}/pay`,{});assert.equal(pay.status,200);
  const rz=pay.data.razorpay;assert.equal(rz.key,KEY_ID);assert.equal(rz.amount,4900);assert.equal(rz.currency,'INR');assert.match(rz.order_id,/^order_TEST/);
  assert.ok(calls.at(-1).auth.startsWith('Basic '));
  assert.equal((await student(`/orders/${id}/pay`,{})).data.razorpay.order_id,rz.order_id,'order id is reused');
  assert.equal((await vendor(`/orders/${id}/status`,{status:'accepted'})).status,409,'unpaid orders cannot be accepted');
  const bad=await student(`/orders/${id}/verify`,{razorpay_order_id:rz.order_id,razorpay_payment_id:'pay_123',razorpay_signature:'0'.repeat(64)});assert.equal(bad.status,400);
  const wrongOrder=await student(`/orders/${id}/verify`,{razorpay_order_id:'order_other',razorpay_payment_id:'pay_123',razorpay_signature:sign('order_other','pay_123')});assert.equal(wrongOrder.status,400);
  const ok=await student(`/orders/${id}/verify`,{razorpay_order_id:rz.order_id,razorpay_payment_id:'pay_123',razorpay_signature:sign(rz.order_id,'pay_123')});assert.equal(ok.status,200);
  assert.equal((await student('/orders')).data.find(o=>o.id===id).payment,'paid');
  assert.equal((await vendor(`/orders/${id}/status`,{status:'accepted'})).status,200);
});

test('live mode: students cannot mark other students orders as paid',async()=>{
  const student=client(),other=client();await login(student,'student');
  assert.equal((await other('/register',{name:'Other',email:'o2@example.test',password:'Testing12345!',role:'student'})).status,201);
  const id=await newOrder(student);const rz=(await student(`/orders/${id}/pay`,{})).data.razorpay;
  const r=await other(`/orders/${id}/verify`,{razorpay_order_id:rz.order_id,razorpay_payment_id:'pay_9',razorpay_signature:sign(rz.order_id,'pay_9')});assert.equal(r.status,403);
});

test('webhook marks order paid with valid signature only, and rejection triggers a refund',async()=>{
  const student=client(),vendor=client();await login(student,'student');await login(vendor,'vendor');
  const id=await newOrder(student);const rz=(await student(`/orders/${id}/pay`,{})).data.razorpay;
  const payload=JSON.stringify({event:'payment.captured',payload:{payment:{entity:{id:'pay_web1',order_id:rz.order_id,amount:rz.amount,currency:'INR'}}}});
  const post=sig=>fetch(base+'/api/razorpay/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Razorpay-Signature':sig},body:payload});
  assert.equal((await post('bad')).status,400);
  assert.equal((await student('/orders')).data.find(o=>o.id===id).payment,'unpaid');
  assert.equal((await post(createHmac('sha256',HOOK).update(payload).digest('hex'))).status,200);
  assert.equal((await student('/orders')).data.find(o=>o.id===id).payment,'paid');
  const rej=await vendor(`/orders/${id}/status`,{status:'rejected',reason:'Closed today'});assert.equal(rej.status,200);
  assert.match(calls.at(-1).url,/\/payments\/pay_web1\/refund$/);assert.equal(calls.at(-1).body.amount,rz.amount);
  assert.equal((await student('/orders')).data.find(o=>o.id===id).payment,'refunded');
});
