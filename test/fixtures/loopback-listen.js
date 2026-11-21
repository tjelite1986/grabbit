'use strict';
// Preloaded with `node -r` by test/helpers/guard-server.js. server.js listens
// on 0.0.0.0, which would make a test server reachable from the LAN for the
// length of the test. This rewrites an all-interfaces bind to 127.0.0.1 and,
// once the socket is bound, prints the real port on stderr so the harness can
// use PORT=0 (an OS-assigned port, no find-then-release race). Test only:
// production code is unchanged.
const net = require('net');

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  if (typeof args[1] === 'string' && (args[1] === '0.0.0.0' || args[1] === '::')) args[1] = '127.0.0.1';
  this.once('listening', () => {
    const a = this.address();
    if (a && typeof a === 'object') process.stderr.write(`GUARD_LISTENING ${a.address} ${a.port}\n`);
  });
  return listen.apply(this, args);
};
