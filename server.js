import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const text = (value, label, max=200) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `Invalid ${label}`);
  return value.trim();
};
const hashToken = token => createHash('sha256').update(token).digest('hex');
function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordMatches(password, stored) {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64));
}
const safeUser = u => ({id:u.id, name:u.name, email:u.email, role:u.role, approved:!!u.approved, emailVerified:!!u.email_verified});

export function createApp({dbPath=join(root,'data','campusloop.db'), demo=false, secureCookies=false, adminEmail='', adminPassword='', razorpayKeyId='', razorpayKeySecret='', razorpayWebhookSecret='', fetchImpl=fetch, resendApiKey='', brevoApiKey='', brevoSenderEmail='', brevoSenderName='CampusLoop', mailFrom='CampusLoop <onboarding@resend.dev>', appUrl='', mailSink=null, trustProxy=false}={}) {
  if(dbPath !== ':memory:') mkdirSync(dirname(dbPath), {recursive:true});
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('student','vendor','admin')), approved INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>0), unit TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY, service_id INTEGER NOT NULL REFERENCES services(id), creator_id INTEGER NOT NULL REFERENCES users(id), location TEXT NOT NULL, target INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS members(group_id INTEGER REFERENCES groups(id), user_id INTEGER REFERENCES users(id), PRIMARY KEY(group_id,user_id));
    CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id), service_id INTEGER NOT NULL REFERENCES services(id), group_id INTEGER REFERENCES groups(id), location TEXT NOT NULL, notes TEXT NOT NULL, quantity INTEGER NOT NULL, amount INTEGER NOT NULL, commission INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', payment TEXT NOT NULL DEFAULT 'unpaid', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(student_id,group_id));
    CREATE TABLE IF NOT EXISTS reviews(order_id INTEGER PRIMARY KEY REFERENCES orders(id), rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), comment TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), actor_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS attachments(order_id INTEGER PRIMARY KEY REFERENCES orders(id), filename TEXT NOT NULL, content BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_orders_student ON orders(student_id);
    CREATE INDEX IF NOT EXISTS idx_services_vendor ON services(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id);
  `);
  const one = (sql,...args) => db.prepare(sql).get(...args);
  const all = (sql,...args) => db.prepare(sql).all(...args);
  const run = (sql,...args) => db.prepare(sql).run(...args);
  const atomic = fn => { db.exec('BEGIN IMMEDIATE'); try { const result=fn(); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  // Bootstrap only a new admin. Never change an existing account or password on restart.
  if(adminEmail && adminPassword && !one("SELECT id FROM users WHERE role='admin'")) {
    const email=text(adminEmail,'admin email',254).toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||adminPassword.length<14) throw new Error('Bootstrap requires a valid admin email and a 14+ character password');
    if(one('SELECT id FROM users WHERE email=?',email)) throw new Error('Admin bootstrap email already belongs to another account');
    run('INSERT INTO users(name,email,password,role,approved) VALUES(?,?,?,?,1)','CampusLoop Administrator',email,passwordHash(adminPassword),'admin');
  }
  for(const col of ['razorpay_order_id','razorpay_payment_id']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${col} TEXT`); } catch {} }
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS vendor_profiles(vendor_id INTEGER PRIMARY KEY REFERENCES users(id), bio TEXT NOT NULL DEFAULT '', hours TEXT NOT NULL DEFAULT '', area TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS coupons(code TEXT PRIMARY KEY, percent INTEGER NOT NULL CHECK(percent BETWEEN 1 AND 50), max_uses INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, owner_id INTEGER REFERENCES users(id), first_order_only INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), sender_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id);
  `);
  for(const [t,c,d] of [['users','email_verified','INTEGER NOT NULL DEFAULT 0'],['users','ref_code','TEXT'],['users','referred_by','INTEGER'],['orders','slot',"TEXT NOT NULL DEFAULT ''"],['orders','coupon',"TEXT NOT NULL DEFAULT ''"],['orders','discount','INTEGER NOT NULL DEFAULT 0'],['vendor_profiles','whatsapp',"TEXT NOT NULL DEFAULT ''"]]) { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); } catch {} }
  const live = !!(razorpayKeyId && razorpayKeySecret);
  const isPaid = p => p==='paid' || p==='simulated_paid';
  const hmac = (secret,data) => createHmac('sha256',secret).update(data).digest('hex');
  const sigOk = (given,expected) => { const a=Buffer.from(String(given||'')), b=Buffer.from(expected); return a.length===b.length && timingSafeEqual(a,b); };
  const rzp = async (path,payload) => {
    const r = await fetchImpl('https://api.razorpay.com/v1'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Basic '+Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')},body:JSON.stringify(payload)});
    const d = await r.json().catch(()=>({}));
    if(!r.ok) { console.error('Razorpay error',r.status,d.error?.description); fail(502,'Payment provider error. Please try again.'); }
    return d;
  };
  const brevoOn = !!(brevoApiKey && brevoSenderEmail);
  const mailOn = brevoOn || !!resendApiKey;
  const sendMail = async (to,subject,body) => {
    mailSink?.({to,subject,body});
    if(!mailOn) { if(!mailSink) console.log(`[email not configured] To: ${to} | ${subject}\n${body}\n`); return; }
    try {
      const r = brevoOn
        ? await fetchImpl('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','api-key':brevoApiKey},body:JSON.stringify({sender:{name:brevoSenderName||'CampusLoop',email:brevoSenderEmail},to:[{email:to}],subject,textContent:body})})
        : await fetchImpl('https://api.resend.com/emails',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${resendApiKey}`},body:JSON.stringify({from:mailFrom,to:[to],subject,text:body})});
      if(!r.ok) console.error('Email send failed',r.status);
    } catch { console.error('Email send failed'); }
  };
  const siteUrl = () => (appUrl||'http://localhost:3000').replace(/\/$/,'');
  const newToken = (userId,kind,ttl) => { const raw=randomBytes(24).toString('hex'); run('DELETE FROM tokens WHERE expires<?',Date.now()); run('INSERT INTO tokens VALUES(?,?,?,?)',hashToken(raw),userId,kind,Date.now()+ttl); return raw; };
  const useToken = (raw,kind) => { const row=one('SELECT * FROM tokens WHERE hash=? AND kind=? AND expires>?',hashToken(String(raw||'')),kind,Date.now()); if(row) run('DELETE FROM tokens WHERE hash=?',row.hash); return row?row.user_id:null; };
  const audit = (actorId,action,detail='') => run('INSERT INTO audit(actor_id,action,detail) VALUES(?,?,?)',actorId||null,action,String(detail).slice(0,300));
  const notify = (userId,subject,body) => { const u=one('SELECT email FROM users WHERE id=?',userId); if(u) sendMail(u.email,subject,body); };
  const waNumber = v => { if(typeof v!=='string'||!v.trim()) return ''; let d=v.replace(/[\s()+-]/g,''); if(!/^\d+$/.test(d)) return null; if(d.length===10) d='91'+d; else if(d.length===11&&d.startsWith('0')) d='91'+d.slice(1); return d.length>=11&&d.length<=15?d:null; };
  const refCode = () => 'REF'+randomBytes(4).toString('hex').toUpperCase();
  const buckets = new Map();
  const limited = (key,max,windowMs) => { const now=Date.now(); if(buckets.size>20000) for(const [k,v] of buckets) if(v.until<now) buckets.delete(k); let b=buckets.get(key); if(!b||b.until<now) {b={count:0,until:now+windowMs};buckets.set(key,b);} b.count++; return b.count>max; };
  const notifyVendorPaid = orderId => { const r=one('SELECT s.vendor_id,s.title FROM orders o JOIN services s ON s.id=o.service_id WHERE o.id=?',orderId); if(r) notify(r.vendor_id,`New paid order #${orderId}`,`A student paid for ${r.title} (order #${orderId}). Open your CampusLoop dashboard to accept it.`); };
  const markPaid = (orderId,paymentId,actorId) => { const changed=atomic(()=>{
    const r=run("UPDATE orders SET payment='paid',razorpay_payment_id=? WHERE id=? AND payment='unpaid'",paymentId,orderId);
    if(r.changes) run('INSERT INTO events(order_id,actor_id,action) VALUES(?,?,?)',orderId,actorId,'Payment received via Razorpay');
    return r.changes>0;
  }); if(changed) notifyVendorPaid(orderId); };
  const csp = live
    ? "default-src 'self'; script-src 'self' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.razorpay.com; connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  const CATEGORIES=['laundry','printing','repairs','food','tutoring','books','cleaning','rentals'];
  if(demo) {
    for(const role of ['student','vendor','admin']) {
      if(!one('SELECT id FROM users WHERE email=?',`${role}@campusloop.test`)) run('INSERT INTO users(name,email,password,role,approved) VALUES(?,?,?,?,1)',`Demo ${role}`,`${role}@campusloop.test`,passwordHash('CampusLoop123!'),role);
    }
    const vendor=one("SELECT id FROM users WHERE email='vendor@campusloop.test'");
    for(const s of [
      ['Laundry pickup','laundry','Wash and fold with a scheduled hostel pickup.',4900,'kg'],
      ['Print & collect','printing','Black-and-white printing. Bring your file to the shop after booking.',200,'page'],
      ['Laptop inspection','repairs','Inspection only; replacement parts and repairs require a separate quote.',9900,'inspection'],
      ['Tiffin meal plan','food','Home-style lunch delivered to your hostel block. Menu changes weekly.',9000,'meal'],
      ['Exam-prep tutoring','tutoring','One-hour small-group session with a senior student. Bring your syllabus.',25000,'session'],
      ['Second-hand textbooks','books','Pre-owned course textbooks and notes, checked for missing pages.',15000,'book'],
      ['Room cleaning','cleaning','Sweeping, mopping and bathroom clean for a hostel room.',15000,'room'],
      ['Cycle rental','rentals','Daily cycle rental for getting around campus. Helmet included.',3000,'day']
    ]) if(!one('SELECT id FROM services WHERE title=? AND vendor_id=?',s[0],vendor.id)) run('INSERT INTO services(vendor_id,title,category,description,price,unit) VALUES(?,?,?,?,?,?)',vendor.id,...s);
  }
  run("UPDATE users SET email_verified=1 WHERE role='admin' OR email LIKE '%@campusloop.test'");
  const attempts=new Map();
  const server=http.createServer(async(req,res)=>{
    const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',csp);
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      const clientIp=(trustProxy?String(req.headers['x-forwarded-for']||'').split(',')[0].trim():'')||req.socket.remoteAddress||'unknown';
      if(path.startsWith('/api/') && path!=='/api/health' && limited('api:'+clientIp,600,60000)) fail(429,'Too many requests. Please slow down.');
      if(path==='/api/health' && req.method==='GET') {one('SELECT 1');return send(200,{status:'ok',version:'1.4.0',payments:live?'razorpay':'simulated'});}
      if(!path.startsWith('/api/')) {
        const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/styles.css':['styles.css','text/css'],'/terms':['terms.html','text/html'],'/privacy':['privacy.html','text/html'],'/refund-policy':['refund-policy.html','text/html'],'/manifest.webmanifest':['manifest.webmanifest','application/manifest+json'],'/sw.js':['sw.js','text/javascript'],'/icon-192.png':['icon-192.png','image/png'],'/icon-512.png':['icon-512.png','image/png']};
        if(req.method!=='GET' || !files[path]) fail(404,'Not found');
        const [file,type]=files[path]; const textual=/^(text\/|application\/manifest)/.test(type);
        res.writeHead(200,{'Content-Type':type+(textual?'; charset=utf-8':''),...(path==='/sw.js'?{'Cache-Control':'no-cache'}:{})}); return res.end(readFileSync(join(root,'public',file)));
      }
      if(path==='/api/razorpay/webhook' && req.method==='POST') {
        if(!razorpayWebhookSecret) fail(404,'Not found');
        const chunks=[];let received=0;for await (const chunk of req) {received+=chunk.length;if(received>65536) fail(413,'Request too large');chunks.push(chunk);}
        const raw=Buffer.concat(chunks).toString('utf8');
        if(!sigOk(req.headers['x-razorpay-signature'],hmac(razorpayWebhookSecret,raw))) fail(400,'Invalid signature');
        let ev;try {ev=JSON.parse(raw);} catch {fail(400,'Invalid JSON');}
        const p=ev.payload?.payment?.entity;
        if(['payment.captured','order.paid'].includes(ev.event) && p?.order_id) {
          const o=one('SELECT id,student_id,amount FROM orders WHERE razorpay_order_id=?',p.order_id);
          if(o && p.amount===o.amount && p.currency==='INR') markPaid(o.id,String(p.id),o.student_id);
        }
        return send(200,{ok:true});
      }
      let body={};
      if(!['GET','HEAD'].includes(req.method)) {
        if(req.headers['x-campusloop-request']!=='1') fail(403,'Missing request header');
        if(!req.headers['content-type']?.startsWith('application/json')) fail(415,'JSON required');
        if(req.headers.origin && new URL(req.headers.origin).host!==req.headers.host) fail(403,'Cross-origin request rejected');
        const maxBytes=/^\/api\/orders\/\d+\/attachment$/.test(path)?4200000:16384;
        const chunks=[];let received=0;for await (const chunk of req) {received+=chunk.length;if(received>maxBytes) fail(413,'Request too large');chunks.push(chunk);}
        const raw=Buffer.concat(chunks).toString('utf8');
        try {body=JSON.parse(raw||'{}');} catch {fail(400,'Invalid JSON');}
        if(!body || typeof body!=='object' || Array.isArray(body)) fail(400,'Invalid body');
      }
      const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('session='))?.slice(8)||'';
      const user=one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?',hashToken(token),Date.now());
      const requireRole=(...roles)=>{if(!user) fail(401,'Please sign in'); if(roles.length && !roles.includes(user.role)) fail(403,'Access denied');};
      const session=u=>{const raw=randomBytes(32).toString('hex');run('DELETE FROM sessions WHERE expires<?',Date.now());run('INSERT INTO sessions VALUES(?,?,?)',hashToken(raw),u.id,Date.now()+86400000);res.setHeader('Set-Cookie',`session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secureCookies?'; Secure':''}`);return safeUser(u);};
      if(path==='/api/me' && req.method==='GET') return send(200,{user:user?safeUser(user):null,demo,payments:live?'razorpay':'simulated',mail:mailOn,testMode:live&&razorpayKeyId.startsWith('rzp_test_')});
      if(['/api/register','/api/login'].includes(path) && req.method==='POST') {
        const ip=clientIp, now=Date.now();
        if(attempts.size>10000) for(const [key,v] of attempts) if(v.until<now) attempts.delete(key);
        const bucket=attempts.get(ip)||{count:0,until:now+60000}; if(bucket.until<now) {bucket.count=0;bucket.until=now+60000;} bucket.count++;attempts.set(ip,bucket);if(bucket.count>30) fail(429,'Too many attempts. Wait a minute.');
        const email=text(body.email,'email',254).toLowerCase(), password=text(body.password,'password',128);
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'Invalid email');
        if(path==='/api/register') {
          if(password.length<10) fail(400,'Use at least 10 characters for your password');
          if(!['student','vendor'].includes(body.role)) fail(400,'Choose student or vendor');
          if(one('SELECT id FROM users WHERE email=?',email)) fail(409,'Email already registered');
          const name=text(body.name,'name',80);
          const id=Number(run('INSERT INTO users(name,email,password,role,approved,ref_code) VALUES(?,?,?,?,?,?)',name,email,passwordHash(password),body.role,body.role==='student'?1:0,body.role==='student'?refCode():null).lastInsertRowid);
          audit(id,'register',body.role);
          sendMail(email,'Verify your CampusLoop email',`Hi ${name},\n\nConfirm your email address using this link (valid for 3 days):\n${siteUrl()}/#verify=${newToken(id,'verify',3*86400000)}\n`);
          return send(201,{user:session(one('SELECT * FROM users WHERE id=?',id))});
        }
        const u=one('SELECT * FROM users WHERE email=?',email);
        if(!u || !passwordMatches(password,u.password)) fail(401,'Incorrect email or password');
        audit(u.id,'login');
        return send(200,{user:session(u)});
      }
      if(path==='/api/logout' && req.method==='POST') {run('DELETE FROM sessions WHERE token=?',hashToken(token));res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(200,{ok:true});}
      if(path==='/api/password' && req.method==='POST') {
        requireRole();const old=text(body.current_password,'current password',128), next=text(body.new_password,'new password',128);
        if(next.length<10) fail(400,'Use at least 10 characters');
        if(!passwordMatches(old,user.password)) fail(403,'Current password is incorrect');
        atomic(()=>{run('UPDATE users SET password=? WHERE id=?',passwordHash(next),user.id);run('DELETE FROM sessions WHERE user_id=?',user.id);});
        audit(user.id,'password changed');
        return send(200,{user:session(user)});
      }
      if(path==='/api/forgot' && req.method==='POST') {
        if(limited('auth:'+clientIp,20,600000)) fail(429,'Too many attempts. Try again later.');
        const u=one('SELECT * FROM users WHERE email=?',text(body.email,'email',254).toLowerCase());
        if(u) { sendMail(u.email,'Reset your CampusLoop password',`Use this link within 1 hour to choose a new password:\n${siteUrl()}/#reset=${newToken(u.id,'reset',3600000)}\n\nIf you did not request this, you can ignore this email.`); audit(u.id,'password reset requested'); }
        return send(200,{ok:true});
      }
      if(path==='/api/reset-password' && req.method==='POST') {
        if(limited('auth:'+clientIp,20,600000)) fail(429,'Too many attempts. Try again later.');
        const next=text(body.password,'password',128); if(next.length<10) fail(400,'Use at least 10 characters');
        const uid=useToken(body.token,'reset'); if(!uid) fail(400,'This reset link is invalid or has expired');
        atomic(()=>{run('UPDATE users SET password=? WHERE id=?',passwordHash(next),uid);run('DELETE FROM sessions WHERE user_id=?',uid);});
        audit(uid,'password reset completed'); return send(200,{ok:true});
      }
      if(path==='/api/verify-email' && req.method==='POST') {
        const uid=useToken(body.token,'verify'); if(!uid) fail(400,'This verification link is invalid or has expired');
        run('UPDATE users SET email_verified=1 WHERE id=?',uid); audit(uid,'email verified'); return send(200,{ok:true});
      }
      if(path==='/api/resend-verification' && req.method==='POST') {
        requireRole(); if(limited('verify:'+user.id,5,3600000)) fail(429,'Too many requests. Try again later.');
        if(!user.email_verified) sendMail(user.email,'Verify your CampusLoop email',`Confirm your email address using this link (valid for 3 days):\n${siteUrl()}/#verify=${newToken(user.id,'verify',3*86400000)}\n`);
        return send(200,{ok:true});
      }
      // Files and receipts share the same ownership boundary as an order.
      const fileRoute=path.match(/^\/api\/orders\/(\d+)\/(attachment|receipt)$/);
      if(fileRoute) {
        requireRole();const id=Number(fileRoute[1]);
        const order=one('SELECT o.*,s.title,s.category,s.vendor_id FROM orders o JOIN services s ON s.id=o.service_id WHERE o.id=?',id);
        if(!order) fail(404,'Order not found');
        if(!(user.role==='admin'||(user.role==='student'&&order.student_id===user.id)||(user.role==='vendor'&&user.approved&&order.vendor_id===user.id))) fail(403,'Access denied');
        if(fileRoute[2]==='receipt' && req.method==='GET') {
          res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="CampusLoop-order-${id}.txt"`,'Cache-Control':'no-store'});
          return res.end(`CAMPUSLOOP — PROJECT ORDER RECEIPT\n${order.payment==='paid'?'PAID ONLINE VIA RAZORPAY':'SIMULATED PAYMENT ONLY'} — NOT A TAX INVOICE\n\nOrder: ${id}\nCreated (UTC): ${order.created}\nService: ${order.title}\nQuantity: ${order.quantity}\nTotal: INR ${(order.amount/100).toFixed(2)}\nStatus: ${order.status}\nPayment: ${order.payment}\nLocation: ${order.location}\nPickup slot: ${order.slot||'not chosen'}\n${order.payment==='paid'?'Paid online via Razorpay.':'No money has been collected by this project.'}\n`);
        }
        if(fileRoute[2]==='attachment' && req.method==='GET') {
          const file=one('SELECT * FROM attachments WHERE order_id=?',id);if(!file) fail(404,'No file uploaded');
          res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="print-order-${id}.pdf"`,'Cache-Control':'no-store'});return res.end(Buffer.from(file.content));
        }
        if(fileRoute[2]==='attachment' && req.method==='POST') {
          if(user.role!=='student'||order.student_id!==user.id) fail(403,'Only the ordering student can upload');
          if(order.category!=='printing'||order.status!=='pending') fail(409,'Files can only be changed for pending print orders');
          const filename=text(body.filename,'filename',120);if(!filename.toLowerCase().endsWith('.pdf')) fail(400,'PDF files only');
          if(typeof body.base64!=='string'||!body.base64.length||body.base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) fail(400,'Invalid file encoding');
          const content=Buffer.from(body.base64,'base64');if(content.length>3*1024*1024) fail(413,'Maximum PDF size is 3 MB');
          if(content.subarray(0,5).toString()!=='%PDF-') fail(400,'File is not a PDF');
          atomic(()=>{run('INSERT INTO attachments VALUES(?,?,?) ON CONFLICT(order_id) DO UPDATE SET filename=excluded.filename,content=excluded.content',id,filename,content);run('INSERT INTO events(order_id,actor_id,action) VALUES(?,?,?)',id,user.id,'Print PDF uploaded');});return send(200,{ok:true});
        }
        fail(405,'Method not allowed');
      }
      if(path==='/api/services' && req.method==='GET') return send(200,all(`SELECT s.*, u.name vendor, (SELECT ROUND(AVG(r.rating),1) FROM reviews r JOIN orders o ON o.id=r.order_id WHERE o.service_id=s.id) rating FROM services s JOIN users u ON u.id=s.vendor_id WHERE u.approved=1 ORDER BY s.id`));
      if(path==='/api/services' && req.method==='POST') {
        requireRole('vendor');if(!user.approved) fail(403,'Admin approval required');
        if(!CATEGORIES.includes(body.category)) fail(400,'Invalid category');
        if(!Number.isInteger(body.price)||body.price<100||body.price>1000000) fail(400,'Price must be 100–1000000 paise');
        const id=run('INSERT INTO services(vendor_id,title,category,description,price,unit) VALUES(?,?,?,?,?,?)',user.id,text(body.title,'title',80),body.category,text(body.description,'description',500),body.price,text(body.unit,'unit',30)).lastInsertRowid;audit(user.id,'service listed',body.title);return send(201,{id:Number(id)});
      }
      if(path==='/api/groups' && req.method==='GET') {
        return send(200,all('SELECT g.*, s.title, s.price, s.unit, (SELECT COUNT(*) FROM members WHERE group_id=g.id) count FROM groups g JOIN services s ON s.id=g.service_id WHERE g.expires>? ORDER BY g.id DESC',Date.now()).map(g=>({...g,joined:user?!!one('SELECT 1 FROM members WHERE group_id=? AND user_id=?',g.id,user.id):false})));
      }
      if(path==='/api/groups' && req.method==='POST') {
        requireRole('student');if(!Number.isInteger(body.target)||body.target<2||body.target>20) fail(400,'Group target must be 2–20');
        if(!one('SELECT s.id FROM services s JOIN users u ON s.vendor_id=u.id WHERE s.id=? AND u.approved=1',Number(body.service_id)||0)) fail(404,'Service not found');
        const id=atomic(()=>{const id=run('INSERT INTO groups(service_id,creator_id,location,target,expires) VALUES(?,?,?,?,?)',body.service_id,user.id,text(body.location,'hostel',120),body.target,Date.now()+86400000).lastInsertRowid;run('INSERT INTO members VALUES(?,?)',id,user.id);return Number(id);}); return send(201,{id});
      }
      let match=path.match(/^\/api\/groups\/(\d+)\/join$/);
      if(match && req.method==='POST') {
        requireRole('student');const id=Number(match[1]),g=one('SELECT * FROM groups WHERE id=?',id);if(!g||g.expires<Date.now()) fail(404,'Group expired or not found');
        if(one('SELECT 1 FROM members WHERE group_id=? AND user_id=?',id,user.id)) fail(409,'Already joined');
        if(one('SELECT COUNT(*) n FROM members WHERE group_id=?',id).n>=g.target) fail(409,'Group is full');
        run('INSERT INTO members VALUES(?,?)',id,user.id);return send(200,{ok:true});
      }
      if(path==='/api/orders' && req.method==='POST') {
        requireRole('student');const s=one('SELECT s.* FROM services s JOIN users u ON u.id=s.vendor_id WHERE s.id=? AND u.approved=1',Number(body.service_id)||0);if(!s) fail(404,'Service not found');
        if(!Number.isInteger(body.quantity)||body.quantity<1||body.quantity>500) fail(400,'Quantity must be 1–500');
        let discount=0,group=null;
        if(body.group_id) {group=one('SELECT * FROM groups WHERE id=?',Number(body.group_id)||0);if(!group||group.expires<Date.now()||group.service_id!==s.id||!one('SELECT 1 FROM members WHERE group_id=? AND user_id=?',group.id,user.id)||one('SELECT COUNT(*) n FROM members WHERE group_id=?',group.id).n<group.target) fail(400,'Group not ready');if(one('SELECT id FROM orders WHERE student_id=? AND group_id=?',user.id,group.id)) fail(409,'Already booked this group');discount=.1;}
        if(mailOn&&!user.email_verified) fail(403,'Please verify your email first. Check your inbox for the link.');
        let slot='';
        if(body.slot!==undefined&&body.slot!=='') {
          const m=/^(\d{4}-\d{2}-\d{2}) (09-12|12-15|15-18|18-21)$/.exec(String(body.slot)), d=m?Date.parse(m[1]+'T00:00:00Z'):NaN, today=Date.parse(new Date().toISOString().slice(0,10)+'T00:00:00Z');
          if(!m||!Number.isFinite(d)||d<today-86400000||d>today+14*86400000) fail(400,'Choose a valid pickup slot');
          slot=String(body.slot);
        }
        let couponPct=0,couponCode='',couponRow=null,referrer=null;
        if(typeof body.coupon==='string'&&body.coupon.trim()) {
          const code=body.coupon.trim().toUpperCase().slice(0,40), hasPrior=!!one("SELECT 1 FROM orders WHERE student_id=? AND status NOT IN ('cancelled','rejected')",user.id);
          couponRow=one('SELECT * FROM coupons WHERE code=? AND active=1',code);
          if(couponRow) {
            if(couponRow.used>=couponRow.max_uses) fail(400,'This coupon has been fully used');
            if(couponRow.owner_id&&couponRow.owner_id!==user.id) fail(400,'This coupon is not valid for your account');
            if(couponRow.first_order_only&&hasPrior) fail(400,'This coupon is only for first orders');
            couponPct=couponRow.percent;
          } else {
            referrer=one("SELECT id FROM users WHERE ref_code=? AND role='student'",code);
            if(!referrer) fail(400,'Invalid coupon code');
            if(referrer.id===user.id) fail(400,'You cannot use your own referral code');
            if(hasPrior||user.referred_by) fail(400,'Referral codes are for first orders only');
            couponPct=10;
          }
          couponCode=code;
        }
        const useCoupon=!!couponCode&&couponPct/100>discount, gross=s.price*body.quantity, amount=Math.round(gross*(1-Math.max(discount,useCoupon?couponPct/100:0)));
        const id=atomic(()=>{const id=run('INSERT INTO orders(student_id,service_id,group_id,location,notes,quantity,amount,commission,slot,coupon,discount) VALUES(?,?,?,?,?,?,?,?,?,?,?)',user.id,s.id,group?.id||null,group?group.location:text(body.location,'location',120),typeof body.notes==='string'?body.notes.slice(0,1000):'',body.quantity,amount,Math.round(amount*.1),slot,useCoupon?couponCode:'',gross-amount).lastInsertRowid;
          if(useCoupon&&couponRow) run('UPDATE coupons SET used=used+1 WHERE code=?',couponCode);
          if(useCoupon&&referrer) run('UPDATE users SET referred_by=? WHERE id=?',referrer.id,user.id);
          run('INSERT INTO events(order_id,actor_id,action) VALUES(?,?,?)',id,user.id,'Created');return Number(id);});return send(201,{id,amount,discount:gross-amount});
      }
      if(path==='/api/orders' && req.method==='GET') {
        requireRole();const where=user.role==='admin'?'1=1':user.role==='vendor'?'s.vendor_id=?':'o.student_id=?';
        const orders=all(`SELECT o.*, s.title, s.category, s.vendor_id, u.name student, r.rating, r.comment, a.filename, vp.whatsapp vendor_whatsapp FROM orders o JOIN services s ON s.id=o.service_id JOIN users u ON u.id=o.student_id LEFT JOIN reviews r ON r.order_id=o.id LEFT JOIN attachments a ON a.order_id=o.id LEFT JOIN vendor_profiles vp ON vp.vendor_id=s.vendor_id WHERE ${where} ORDER BY o.id DESC`,...(user.role==='admin'?[]:[user.id]));
        return send(200,orders.map(o=>({...o,events:all('SELECT action,created FROM events WHERE order_id=? ORDER BY id',o.id)})));
      }
      const chat=path.match(/^\/api\/orders\/(\d+)\/messages$/);
      if(chat && ['GET','POST'].includes(req.method)) {
        requireRole();const id=Number(chat[1]),o=one('SELECT o.id,o.student_id,s.vendor_id FROM orders o JOIN services s ON s.id=o.service_id WHERE o.id=?',id);if(!o) fail(404,'Order not found');
        const isStudent=user.role==='student'&&o.student_id===user.id, isVendor=user.role==='vendor'&&user.approved&&o.vendor_id===user.id;
        if(!(isStudent||isVendor||user.role==='admin')) fail(403,'Access denied');
        if(req.method==='POST') {
          if(user.role==='admin') fail(403,'Admins can read messages but not post');
          const msg=text(body.body,'message',500);
          if(one('SELECT COUNT(*) n FROM messages WHERE order_id=?',id).n>=200) fail(429,'Message limit reached for this order');
          run('INSERT INTO messages(order_id,sender_id,body) VALUES(?,?,?)',id,user.id,msg);
          notify(isStudent?o.vendor_id:o.student_id,`New message on order #${id}`,`${user.name}: ${msg}\n\nOpen CampusLoop to reply.`);
        }
        return send(200,all('SELECT m.id,m.body,m.created,u.name sender,u.role sender_role FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.order_id=? ORDER BY m.id',id));
      }
      const vp=path.match(/^\/api\/vendors\/(\d+)$/);
      if(vp && req.method==='GET') {
        const v=one("SELECT id,name FROM users WHERE id=? AND role='vendor' AND approved=1",Number(vp[1]));if(!v) fail(404,'Vendor not found');
        const rv='FROM reviews r JOIN orders o ON o.id=r.order_id JOIN services s ON s.id=o.service_id WHERE s.vendor_id=?';
        return send(200,{...v,...(one('SELECT bio,hours,area,whatsapp FROM vendor_profiles WHERE vendor_id=?',v.id)||{bio:'',hours:'',area:'',whatsapp:''}),rating:one(`SELECT ROUND(AVG(r.rating),1) average, COUNT(*) count ${rv}`,v.id),reviews:all(`SELECT r.rating,r.comment ${rv} ORDER BY o.id DESC LIMIT 10`,v.id),services:all('SELECT id,title,category,description,price,unit FROM services WHERE vendor_id=? ORDER BY id',v.id)});
      }
      if(path==='/api/profile' && ['GET','POST'].includes(req.method)) {
        requireRole('vendor');
        if(req.method==='POST') {const f=(v,n)=>typeof v==='string'?v.trim().slice(0,n):'';const wa=waNumber(body.whatsapp);if(wa===null) fail(400,'Enter a valid WhatsApp number: 10 digits, or with country code');run('INSERT INTO vendor_profiles(vendor_id,bio,hours,area,whatsapp) VALUES(?,?,?,?,?) ON CONFLICT(vendor_id) DO UPDATE SET bio=excluded.bio,hours=excluded.hours,area=excluded.area,whatsapp=excluded.whatsapp',user.id,f(body.bio,500),f(body.hours,120),f(body.area,120),wa);audit(user.id,'profile updated');}
        return send(200,one('SELECT bio,hours,area,whatsapp FROM vendor_profiles WHERE vendor_id=?',user.id)||{bio:'',hours:'',area:'',whatsapp:''});
      }
      if(path==='/api/coupons/mine' && req.method==='GET') {
        requireRole('student');if(!user.ref_code) {user.ref_code=refCode();run('UPDATE users SET ref_code=? WHERE id=?',user.ref_code,user.id);}
        return send(200,{ref_code:user.ref_code,coupons:all('SELECT code,percent,first_order_only FROM coupons WHERE active=1 AND used<max_uses AND (owner_id=? OR owner_id IS NULL) ORDER BY code',user.id)});
      }
      if(path==='/api/admin/coupons' && ['GET','POST'].includes(req.method)) {
        requireRole('admin');
        if(req.method==='POST') {
          const code=String(body.code||'').trim().toUpperCase();
          if(!/^[A-Z0-9_-]{3,24}$/.test(code)||code.startsWith('REF')||code.startsWith('THANKS')) fail(400,'Code must be 3–24 letters/numbers and not start with REF or THANKS');
          if(!Number.isInteger(body.percent)||body.percent<1||body.percent>50) fail(400,'Discount must be 1–50%');
          if(!Number.isInteger(body.max_uses)||body.max_uses<1||body.max_uses>100000) fail(400,'Max uses must be 1–100000');
          if(one('SELECT 1 FROM coupons WHERE code=?',code)) fail(409,'Coupon code already exists');
          run('INSERT INTO coupons(code,percent,max_uses,first_order_only) VALUES(?,?,?,?)',code,body.percent,body.max_uses,body.first_order_only?1:0);audit(user.id,'coupon created',code);return send(201,{ok:true});
        }
        return send(200,all('SELECT code,percent,max_uses,used,owner_id,first_order_only,active FROM coupons ORDER BY rowid DESC'));
      }
      if(path==='/api/vendor/earnings' && req.method==='GET') {
        requireRole('vendor');const base='FROM orders o JOIN services s ON s.id=o.service_id WHERE s.vendor_id=?';
        const tot=one(`SELECT COUNT(*) orders,COALESCE(SUM(o.amount),0) gross,COALESCE(SUM(o.commission),0) fees ${base} AND o.status='completed'`,user.id);
        const pending=one(`SELECT COUNT(*) orders,COALESCE(SUM(o.amount-o.commission),0) net ${base} AND o.status IN ('accepted','in_progress','ready') AND o.payment IN ('paid','simulated_paid')`,user.id);
        const days=all(`SELECT substr(e.created,1,10) day,COUNT(*) orders,SUM(o.amount-o.commission) net FROM orders o JOIN services s ON s.id=o.service_id JOIN events e ON e.order_id=o.id AND e.action='completed' WHERE s.vendor_id=? AND o.status='completed' AND e.created>=date('now','-13 days') GROUP BY day ORDER BY day`,user.id);
        return send(200,{totals:{orders:tot.orders,gross:tot.gross,fees:tot.fees,net:tot.gross-tot.fees},pending,days});
      }
      if(path==='/api/vendor/earnings.csv' && req.method==='GET') {
        requireRole('vendor');const q=new URL(req.url,'http://localhost').searchParams,dateOk=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'');
        if((q.get('from')&&!dateOk(q.get('from')))||(q.get('to')&&!dateOk(q.get('to')))) fail(400,'Dates must look like 2026-11-30');
        const rows=all(`SELECT o.id,substr(e.created,1,10) completed,s.title,o.quantity,u.name student,o.slot,o.amount,o.commission,o.payment,o.coupon FROM orders o JOIN services s ON s.id=o.service_id JOIN users u ON u.id=o.student_id JOIN events e ON e.order_id=o.id AND e.action='completed' WHERE s.vendor_id=? AND o.status='completed' AND substr(e.created,1,10)>=? AND substr(e.created,1,10)<=? ORDER BY e.created,o.id`,user.id,q.get('from')||'0000-01-01',q.get('to')||'9999-12-31');
        const cell=v=>{let t=String(v??'');if(/^[=+\-@\t\r]/.test(t)) t="'"+t;return /[",\n\r]/.test(t)?'"'+t.replaceAll('"','""')+'"':t;}, inr=n=>(n/100).toFixed(2);
        const lines=[['Order ID','Completed (UTC date)','Service','Quantity','Student','Pickup slot','Gross (INR)','Platform fee (INR)','Net to pay vendor (INR)','Payment','Coupon','Payout done? (Y/N)'].join(',')];
        for(const r of rows) lines.push([r.id,r.completed,r.title,r.quantity,r.student,r.slot,inr(r.amount),inr(r.commission),inr(r.amount-r.commission),r.payment,r.coupon,''].map(cell).join(','));
        const gross=rows.reduce((a,r)=>a+r.amount,0),fees=rows.reduce((a,r)=>a+r.commission,0);
        lines.push(['TOTAL','','',rows.reduce((a,r)=>a+r.quantity,0),'','',inr(gross),inr(fees),inr(gross-fees),'','',''].map(cell).join(','));
        audit(user.id,'earnings exported',`${rows.length} orders`);
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="campusloop-earnings-${new Date().toISOString().slice(0,10)}.csv"`,'Cache-Control':'no-store'});
        return res.end('\ufeff'+lines.join('\r\n')+'\r\n');
      }
      if(path==='/api/admin/audit' && req.method==='GET') {requireRole('admin');return send(200,all('SELECT a.id,a.action,a.detail,a.created,u.name actor FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100'));}
      const rf=path.match(/^\/api\/admin\/orders\/(\d+)\/refund$/);
      if(rf && req.method==='POST') {
        requireRole('admin');const id=Number(rf[1]),o=one('SELECT * FROM orders WHERE id=?',id);if(!o) fail(404,'Order not found');
        if(o.payment!=='refund_due') fail(409,'This order has no refund due');
        if(!body.manual) {
          if(!live||!o.razorpay_payment_id) fail(400,'Online refund is not available. Refund it in the Razorpay dashboard, then mark it refunded.');
          await rzp(`/payments/${o.razorpay_payment_id}/refund`,{amount:o.amount,notes:{order_id:String(id)}});
        }
        atomic(()=>{run("UPDATE orders SET payment='refunded' WHERE id=?",id);run('INSERT INTO events(order_id,actor_id,action) VALUES(?,?,?)',id,user.id,body.manual?'Refund marked as paid by admin':'Refund issued via Razorpay');});
        audit(user.id,'refund '+(body.manual?'marked manually':'issued'),`#${id}`);notify(o.student_id,`Refund for order #${id}`,`Your refund for order #${id} has been processed. Banks usually take 5–7 working days to show it.`);return send(200,{ok:true});
      }
      match=path.match(/^\/api\/orders\/(\d+)\/(pay|status|review|verify)$/);
      if(match && req.method==='POST') {
        requireRole();const id=Number(match[1]), action=match[2],o=one('SELECT o.*,s.vendor_id FROM orders o JOIN services s ON s.id=o.service_id WHERE o.id=?',id);if(!o) fail(404,'Order not found');
        if(action==='pay') {
          if(user.role!=='student'||o.student_id!==user.id) fail(403,'Access denied');
          if(o.status!=='pending'||o.payment!=='unpaid') fail(409,'Order cannot be paid');
          if(live) {
            let rzId=o.razorpay_order_id;
            if(!rzId) {rzId=(await rzp('/orders',{amount:o.amount,currency:'INR',receipt:`campusloop_${id}`,notes:{order_id:String(id)}})).id;run('UPDATE orders SET razorpay_order_id=? WHERE id=?',rzId,id);}
            return send(200,{razorpay:{key:razorpayKeyId,order_id:rzId,amount:o.amount,currency:'INR',name:user.name,email:user.email}});
          }
          atomic(()=>{run("UPDATE orders SET payment='simulated_paid' WHERE id=?",id);run('INSERT INTO events(order_id,actor_id,action) VALUES(?,?,?)',id,user.id,'Demo payment recorded — no money moved');});
          notifyVendorPaid(id);
        } else if(action==='verify') {
          if(user.role!=='student'||o.student_id!==user.id) fail(403,'Access denied');
          if(!live) fail(400,'Online payments are not enabled');
          if(isPaid(o.payment)) return send(200,{ok:true});
          if(!o.razorpay_order_id||o.status!=='pending') fail(409,'Order cannot be paid');
          const pid=String(body.razorpay_payment_id||'');
          if(!/^pay_[A-Za-z0-9]+$/.test(pid)||body.razorpay_order_id!==o.razorpay_order_id||!sigOk(body.razorpay_signature,hmac(razorpayKeySecret,`${o.razorpay_order_id}|${pid}`))) fail(400,'Payment could not be verified');
          markPaid(id,pid,user.id);
        } else if(action==='review') {
          if(user.role!=='student'||o.student_id!==user.id) fail(403,'Access denied');
          if(o.status!=='completed') fail(409,'Complete the order before reviewing');
          if(!Number.isInteger(body.rating)||body.rating<1||body.rating>5) fail(400,'Rating must be 1–5');
          if(one('SELECT 1 FROM reviews WHERE order_id=?',id)) fail(409,'Already reviewed');
          run('INSERT INTO reviews VALUES(?,?,?)',id,body.rating,typeof body.comment==='string'?body.comment.slice(0,500):'');
        } else {
          const cancellation=body.status==='cancelled', rejection=body.status==='rejected';
          if(cancellation) {
            if(user.role!=='student'||o.student_id!==user.id) fail(403,'Access denied');
            if(o.status!=='pending') fail(409,'Only pending orders may be cancelled');
          } else if(rejection) {
            if(user.role!=='vendor'||o.vendor_id!==user.id||!user.approved) fail(403,'Access denied');
            if(o.status!=='pending') fail(409,'Only pending orders can be rejected');
            text(body.reason,'rejection reason',200);
          } else {
            if(user.role!=='vendor'||o.vendor_id!==user.id||!user.approved) fail(403,'Access denied');
            const next={pending:'accepted',accepted:'in_progress',in_progress:'ready',ready:'completed'};
            if(next[o.status]!==body.status||!isPaid(o.payment)) fail(409,'Invalid transition or unpaid order');
          }
          let newPayment=o.payment;
          if((cancellation||rejection)&&isPaid(o.payment)) {
            if(o.payment==='simulated_paid') newPayment='simulated_refunded';
            else if(live&&o.razorpay_payment_id) { try {await rzp(`/payments/${o.razorpay_payment_id}/refund`,{amount:o.amount,notes:{order_id:String(id)}});newPayment='refunded';} catch(e) {console.error('Refund failed for order',id);newPayment='refund_due';} }
            else newPayment='refund_due';
          }
          atomic(()=>{run('UPDATE orders SET status=?,payment=? WHERE id=?',body.status,newPayment,id);run('INSERT INTO events(order_id,actor_id,action) VALUES(?,?,?)',id,user.id,rejection?`rejected: ${body.reason.trim()}`:body.status);
            if(o.coupon&&(cancellation||rejection)) {run('UPDATE coupons SET used=MAX(used-1,0) WHERE code=?',o.coupon);run('UPDATE users SET referred_by=NULL WHERE id=? AND referred_by=(SELECT id FROM users WHERE ref_code=?)',o.student_id,o.coupon);}
            if(o.coupon&&body.status==='completed') {const ref=one("SELECT id FROM users WHERE ref_code=? AND role='student'",o.coupon);if(ref) {run('INSERT OR IGNORE INTO coupons(code,percent,max_uses,owner_id,first_order_only) VALUES(?,?,?,?,?)',`THANKS${id}`,10,1,ref.id,0);}}
          });
          const msgs={accepted:'was accepted by the vendor',in_progress:'is now in progress',ready:'is READY. Please collect it or be available for delivery',completed:'is completed. You can now leave a review',rejected:`was rejected: ${rejection?body.reason.trim():''}`,cancelled:'was cancelled'};
          if(msgs[body.status]&&user.id!==o.student_id) notify(o.student_id,`Order #${id} update`,`Your order #${id} ${msgs[body.status]}.`);
          if(body.status==='completed'&&o.coupon) {const ref=one("SELECT id FROM users WHERE ref_code=? AND role='student'",o.coupon);if(ref) notify(ref.id,'You earned a referral reward','A friend completed their first order with your code. A 10% coupon (THANKS'+id+') is now in your CampusLoop account.');}
          audit(user.id,`order ${body.status}`,`#${id}`);
        }
        return send(200,{ok:true});
      }
      if(path==='/api/admin' && req.method==='GET') {
        requireRole('admin');return send(200,{refunds:all("SELECT o.id,o.amount,o.razorpay_payment_id IS NOT NULL has_payment,s.title,u.name student FROM orders o JOIN services s ON s.id=o.service_id JOIN users u ON u.id=o.student_id WHERE o.payment='refund_due' ORDER BY o.id"),vendors:all("SELECT id,name,email,approved FROM users WHERE role='vendor'"),metrics:one("SELECT COUNT(*) total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed, COALESCE(SUM(CASE WHEN status='completed' THEN amount ELSE 0 END),0) gmv, COALESCE(SUM(CASE WHEN status='completed' THEN commission ELSE 0 END),0) commission FROM orders")});
      }
      match=path.match(/^\/api\/vendors\/(\d+)\/approve$/);
      if(match && req.method==='POST') {requireRole('admin');const r=run("UPDATE users SET approved=1 WHERE id=? AND role='vendor'",Number(match[1]));if(!r.changes) fail(404,'Vendor not found');audit(user.id,'vendor approved',`#${match[1]}`);return send(200,{ok:true});}
      fail(404,'Not found');
    } catch(e) { if(!e.code||!Number.isInteger(e.code)) console.error(e);send(Number.isInteger(e.code)?e.code:500,{error:Number.isInteger(e.code)?e.message:'Internal server error'}); }
  });
  server.on('close',()=>db.close());
  return {server,db};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const demo=process.argv.includes('--demo')||process.env.DEMO_MODE==='true';
  const {server}=createApp({demo,dbPath:process.env.DB_PATH||join(root,'data','campusloop.db'),secureCookies:process.env.SECURE_COOKIES==='true',adminEmail:process.env.ADMIN_EMAIL,adminPassword:process.env.ADMIN_PASSWORD,razorpayKeyId:process.env.RAZORPAY_KEY_ID,razorpayKeySecret:process.env.RAZORPAY_KEY_SECRET,razorpayWebhookSecret:process.env.RAZORPAY_WEBHOOK_SECRET,resendApiKey:process.env.RESEND_API_KEY,brevoApiKey:process.env.BREVO_API_KEY,brevoSenderEmail:process.env.MAIL_FROM_EMAIL,brevoSenderName:process.env.MAIL_FROM_NAME||undefined,mailFrom:process.env.MAIL_FROM||undefined,appUrl:process.env.APP_URL,trustProxy:process.env.TRUST_PROXY==='true'});
  const port=Number(process.env.PORT)||3000;
  server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`CampusLoop: http://localhost:${port} | ${demo?'Demo accounts enabled':'No demo seeding'} | ${process.env.RAZORPAY_KEY_ID&&process.env.RAZORPAY_KEY_SECRET?'Razorpay payments ON':'simulated payments only'}`));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
