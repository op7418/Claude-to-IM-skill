// Force IPv4-only DNS lookup to fix ENETUNREACH on IPv6 networks (e.g. SteamOS with NVM Node.js)
// Loaded via --require when CTI_FORCE_IPV4=1 is set.
const dns = require('dns');
const orig = dns.lookup.bind(dns);
dns.lookup = (hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  orig(hostname, { ...options, family: 4 }, callback);
};
