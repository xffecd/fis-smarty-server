var path = require('path');
var util = fis.require('command-server/lib/util.js');
var spawn = require('child_process').spawn;
var fs = require('fs');
var tar = require('tar');

function extract(src, folder, callback) {
  fs
    .createReadStream(src)
    .pipe(tar.Extract({
      path: folder
    }))
    .on('error', function(err) {
      if (callback) {
        callback(err);
      } else {
        fis.log.error('extract tar file [%s] fail, error [%s]', tmp, err);
      }
    })
    .on('end', function() {
      callback && callback(null, src, folder);
    });
}

function checkPHPEnable(opt, callback) {
  var check = function(data) {
    if (!phpVersion) {
      phpVersion = util.matchVersion(data.toString('utf8'));
      if (phpVersion) {
        process.stdout.write('v' + phpVersion + '\n');
      }
    }
  };
  //check php-cgi
  process.stdout.write('checking php-cgi support : ');
  var php = spawn(opt.php_exec || 'php-cgi', ['--version']);
  var phpVersion = false;
  php.stdout.on('data', check);
  php.stderr.on('data', check);
  php.on('error', function() {
    process.stdout.write('unsupported php-cgi environment\n');
    // fis.log.notice('launching java server.');
    delete opt.php_exec;
    callback(phpVersion, opt);
  });
  php.on('exit', function() {
    callback(phpVersion, opt);
  })
}

function checkJavaEnable(opt, callback) {
  var javaVersion = false;
  //check java
  process.stdout.write('checking java support : ');
  var java = spawn('java', ['-version']);

  java.stderr.on('data', function(data) {
    if (!javaVersion) {
      javaVersion = util.matchVersion(data.toString('utf8'));
      if (javaVersion) {
        process.stdout.write('v' + javaVersion + '\n');
      }
    }
  });

  java.on('error', function(err) {
    process.stdout.write('java not support!');
    fis.log.warning(err);
    callback(javaVersion, opt);
  });

  java.on('exit', function() {
    if (!javaVersion) {
      process.stdout.write('java not support!');
    }

    callback(javaVersion, opt);
  });
}

function start(opt, callback) {
  process.stdout.write('starting fis-server .');
  var timeout = Math.max(opt.timeout * 1000, 5000);
  delete opt.timeout;

  var errMsg = 'fis-server fails to start at port [' + opt.port + '], error: ';
  var args = [
    '-Dorg.apache.jasper.compiler.disablejsr199=true',
    //'-Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider',
    '-jar', path.join(__dirname, 'server.jar')
  ];

  var ready = false;
  var log = '';
  var timeoutTimer;

  opt.php_exec = opt.php_exec || 'php-cgi';
  if (!opt.https) {
    delete opt.https;
  }

  if (typeof opt.rewrite === 'undefined') {
    opt.rewrite = fis.get('server.rewrite', true);
  }

  fis.util.map(opt, function(key, value) {
    args.push('--' + key, String(value));
  });

  var server = spawn('java', args, {
    cwd: __dirname,
    detached: opt.daemon
  });

  server.stderr.on('data', function(chunk) {
    //console.log(chunk.toString('utf8'));
    if (ready) return;
    chunk = chunk.toString('utf8');
    log += chunk;
    process.stdout.write('.');
    if (chunk.indexOf('Started SelectChannelConnector@') > 0 || chunk.indexOf('Started SslSocketConnector@') > 0) {
      ready = true;
      clearTimeout(timeoutTimer);
      process.stdout.write(' at port [' + opt.port + ']\n');

      function open() {
        var protocol = opt.https ? "https" : "http";
        var address = protocol + '://127.0.0.1' + (opt.port == 80 ? '/' : ':' + opt.port + '/');

        fis.log.notice('Browse ' + '%s'.yellow.bold, address);
        fis.log.notice('Or browse ' + '%s'.yellow.bold, protocol + '://' + util.hostname + (opt.port == 80 ? '/' : ':' + opt.port + '/'));

        console.log();

        opt.browse ? util.open(address, function() {
          opt.daemon && process.exit();
        }) : (opt.daemon && process.exit());

      }

      var indexPHP = path.join(opt.root, 'index.php');
      if (!fis.util.exists(indexPHP)) {
        extract(path.join(__dirname, 'framework.tar'), opt.root, open);
      } else {
        setTimeout(open, 200);
      }
    } else if (chunk.indexOf('Exception') > 0) {
      process.stdout.write(' fail\n');
      try {
        process.kill(server.pid, 'SIGKILL');
      } catch (e) {}
      var match = chunk.match(/exception:?\s+([^\r\n]+)/i);
      if (match) {
        errMsg += match[1];
      } else {
        errMsg += 'unknown';
      }
      console.log(log);
      fis.log.error(errMsg);
    }
  });
  server.on('error', function(err) {
    try {
      process.kill(server.pid, 'SIGKILL');
    } catch (e) {}
    fis.log.error(err);
  });

  if (opt.daemon) {
    util.pid(server.pid);
    server.unref();

    timeoutTimer = setTimeout(function() {
      process.stdout.write(' fail\n');
      if (log) console.log(log);
      fis.log.error('timeout');
    }, timeout);
  } else {
    server.stdout.pipe(process.stdout);
    server.stderr.pipe(process.stderr);
  }
}

exports.start = function(opt, callback) {

  // env check.
  checkPHPEnable(opt, function(php) {
    if (php) {
      checkJavaEnable(opt, function(java) {
        if (java) {
          // seems ok
          start(opt, callback)
        } else {
          callback('`java` is required.');
        }
      });
    } else {
      callback('`php-cgi` is required.');
    }
  });
};

exports.clean = function(options) {
  var argExclude = options.exclude || [];

  if (!Array.isArray(argExclude)) {
    argExclude = [argExclude];
  }

  // merge command args
  var exclude = [
    '/fisdata/**',
    '/index.php',
    '/rewrite/**',
    '/server.log',
    '/smarty/**',
    '/WEB-INF/**',
    '/php-simulation-env/**',
    '/welcome.php'
  ].concat(argExclude);

  // because fis.util.glob beginning with `^/`，so need fix it.
  exclude = exclude.map(function (pattern) {
    var reg = fis.util.glob(pattern);
    return new RegExp('^' + fis.util.escapeReg(options.root) + reg.source.substring(1));
  });

  fis.util.del(options.root,
    options.include || fis.get('server.clean.include'),
    options.exclude || exclude || fis.get('server.clean.exclude')
  );
};
