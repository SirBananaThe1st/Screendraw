// Minimal zero-dependency UPnP IGD client: asks your router to forward a TCP
// port to this computer, the same thing you'd otherwise set up by hand in the
// router's admin page. Works on most home routers with UPnP enabled.
const dgram = require('dgram');
const http = require('http');
const net = require('net');

const SSDP_ADDR = '239.255.255.250';
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

function discover(timeout = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set();
    let done = false, early = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(early);
      try { sock.close(); } catch { /* already closed */ }
      resolve([...found]);
    };
    const timer = setTimeout(finish, timeout);
    sock.on('error', finish);
    sock.on('message', (msg) => {
      const m = /^location:\s*(\S+)/im.exec(msg.toString());
      if (!m) return;
      found.add(m[1]);
      if (!early) early = setTimeout(finish, 600); // give other replies a moment
    });
    sock.bind(0, () => {
      for (const st of SEARCH_TARGETS) {
        const msg = Buffer.from(
          `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`
        );
        sock.send(msg, 1900, SSDP_ADDR, () => {});
      }
    });
  });
}

function httpText(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { timeout: 4000, ...options }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const tag = (xml, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : null;
};

async function findService(location) {
  const { text } = await httpText(location);
  const base = tag(text, 'URLBase') || location;
  for (const block of text.match(/<service>[\s\S]*?<\/service>/gi) || []) {
    const type = tag(block, 'serviceType');
    if (type && /WAN(IP|PPP)Connection/.test(type)) {
      return { type, control: new URL(tag(block, 'controlURL'), base).href };
    }
  }
  return null;
}

async function soap(service, action, args = {}) {
  const params = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  const body =
    `<?xml version="1.0"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${service.type}">${params}</u:${action}></s:Body></s:Envelope>`;
  const res = await httpText(service.control, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${service.type}#${action}"`,
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (res.status !== 200) {
    const err = new Error(tag(res.text, 'errorDescription') || `HTTP ${res.status}`);
    err.code = Number(tag(res.text, 'errorCode')) || res.status;
    throw err;
  }
  return res.text;
}

// The LAN address this machine uses to reach the router.
function localAddressFor(url) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: hostname, port: Number(port) || 80, timeout: 3000 });
    s.once('connect', () => { resolve(s.localAddress.replace(/^::ffff:/, '')); s.destroy(); });
    s.once('timeout', () => { s.destroy(); reject(new Error('timeout')); });
    s.once('error', reject);
  });
}

/**
 * Forward `port` (TCP) on the router to this machine.
 * Resolves { externalIp, internalIp, close() } or throws with a readable message.
 */
async function mapPort(port, description = 'ScreenDraw') {
  const locations = await discover();
  if (!locations.length) throw new Error('No UPnP router found (UPnP may be turned off in your router settings).');

  let service = null;
  for (const loc of locations) {
    try { service = await findService(loc); } catch { /* try next */ }
    if (service) break;
  }
  if (!service) throw new Error('Router found, but it does not offer port mapping over UPnP.');

  const internalIp = await localAddressFor(service.control);
  const add = (lease) => soap(service, 'AddPortMapping', {
    NewRemoteHost: '',
    NewExternalPort: port,
    NewProtocol: 'TCP',
    NewInternalPort: port,
    NewInternalClient: internalIp,
    NewEnabled: 1,
    NewPortMappingDescription: description,
    NewLeaseDuration: lease,
  });

  let lease = 7200;
  try {
    await add(lease);
  } catch (err) {
    if (err.code === 725) { lease = 0; await add(0); } // router only allows permanent mappings
    else if (err.code === 718) {
      // Port already mapped: fine if it already points at us, otherwise report it.
      const xml = await soap(service, 'GetSpecificPortMappingEntry', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' });
      const client = tag(xml, 'NewInternalClient');
      if (client !== internalIp) throw new Error(`Port ${port} is already forwarded to another device (${client}). Pick a different port.`);
    } else throw new Error(`Router refused the port mapping: ${err.message}`);
  }

  let externalIp = null;
  try { externalIp = tag(await soap(service, 'GetExternalIPAddress'), 'NewExternalIPAddress'); } catch { /* optional */ }

  // Leases expire, so renew them while the server runs.
  const renew = lease ? setInterval(() => add(lease).catch(() => {}), (lease / 2) * 1000) : null;
  renew?.unref();

  return {
    externalIp,
    internalIp,
    async close() {
      clearInterval(renew);
      await soap(service, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' }).catch(() => {});
    },
  };
}

module.exports = { mapPort };
