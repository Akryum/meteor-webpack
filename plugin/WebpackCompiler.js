const webpack = Npm.require('webpack');
const _ = Npm.require('underscore');
const MemoryFS = Npm.require('memory-fs');
const shell = Npm.require('shelljs');
const mkdirp = Npm.require('mkdirp');

const fs = Plugin.fs;
const path = Plugin.path;

const _fs = Npm.require('fs');
const _path = Npm.require('path');

const npm = Npm.require('npm');
const http = Npm.require('http');
const connect = Npm.require('connect');
const cors = Npm.require('cors');

let devServerApp = null;
let devServerMiddleware = {};
let devServerHotMiddleware = {};
let configHashes = {};
let webpackStats = null;

const IS_WINDOWS = process.platform === 'win32';
const CWD = _path.resolve('./');
const WEBPACK_NPM = _path.join(CWD, '.meteor', 'local', 'webpack-npm');
const ROOT_WEBPACK_NPM = _path.join(WEBPACK_NPM, 'node_modules');
const PROCESS_ENV = process.env;

const argv = process.argv.map(arg => arg.toLowerCase());

// Detect production mode
let IS_BUILD =
  argv.indexOf('build') >= 0 ||
  argv.indexOf('bundle') >= 0 ||
  argv.indexOf('deploy') >= 0;

let IS_DEBUG =
  PROCESS_ENV.NODE_ENV !== 'production' &&
  argv.indexOf('--production') < 0 &&
  (!IS_BUILD || argv.indexOf('--debug') >= 0);

WebpackCompiler = class WebpackCompiler {
  processFilesForTarget(files, options) {
    // Waiting for the PR to be merged
    // https://github.com/meteor/meteor/pull/5448
    if (options) {
      IS_DEBUG = options.buildMode !== 'production';
    }

    const packageFiles = files.filter(file => file.getPackageName() !== null);

    if (packageFiles && packageFiles.length > 0) {
      throw new Error('You cannot use the webpack compiler inside a package');
    }

    const configFiles = filterFiles(files, 'webpack.conf.js');

    if (configFiles.length === 0) {
      throw new Error('Missing webpack.conf.js file');
    }

    const platform = configFiles[0].getArch();
    const shortName =
      (platform.indexOf('cordova') >= 0) ?
        'cordova' :
        (platform.indexOf('web') >= 0) ? 'web' : 'server';

    // Don't need to run NPM install again on mirrors
    if (!PROCESS_ENV.IS_MIRROR) {
      runNpmInstall(shortName, filterFiles(files, 'webpack.packages.json'));
    }

    runWebpack(shortName, configFiles);

    // Every startup.js files are sent directly to Meteor
    files.filter(file => file.getBasename() === 'meteor.startup.js').forEach(file => {
      file.addJavaScript({
        path: file.getPathInPackage(),
        data: file.getContentsAsString()
      });
    });
  }
}

let npmPackagesCache = { web: {}, cordova: {}, server: {} };

function runNpmInstall(target, files) {
  // Make sure NPM is installed so we can use CLI
  if (!fs.existsSync(ROOT_WEBPACK_NPM + '/npm')) {
    console.log('Installing local NPM...');

    Meteor.wrapAsync(function(done) {
      npm.load({ loglevel: 'silent' }, function(err) {
        if (err) {
          throw err;
        }

        npm.commands.install(WEBPACK_NPM, ['npm@3.5.2'], function(err) {
          if (err) {
            throw err;
          }

          done();
        })
      });
    })();
  }

  // List the dependencies
  // Fix peer dependencies for react and webpack
  // webpack-hot-middleware is required for HMR
  let dependencies = {
    'react': '~0.14.1',
    'webpack': '^1.12.9',
    'webpack-hot-middleware': '^2.4.1'
  };

  files.forEach(file => {
    try {
      const deps = JSON.parse(file.getContentsAsString());
      dependencies = _.extend(dependencies, deps);
    } catch(e) {
      file.error({
        message: e.message
      });
    }
  });

  let hasChanged = false;

  for (let name in dependencies) {
    if (npmPackagesCache[target][name] !== dependencies[name]) {
      hasChanged = true;
      npmPackagesCache[target][name] = dependencies[name];
    }
  }

  if (!hasChanged) {
    return;
  }

  const npmPackage = {
    name: 'webpack-internal-package',
    description: 'generated by webpack:webpack',
    version: '0.0.0',
    private: true,
    license: 'none',
    repository: {
      type: 'git',
      url: 'https://github.com/thereactivestack/meteor-webpack'
    },
    dependencies
  };

  fs.writeFileSync(_path.join(WEBPACK_NPM, '/package.json'), JSON.stringify(npmPackage));

  console.log('Installing NPM dependencies for the ' + target + ' bundle...');

  const NPM_CLI = _path.join(ROOT_WEBPACK_NPM, '.bin', IS_WINDOWS ? 'npm.cmd' : 'npm')

  process.chdir(WEBPACK_NPM);
  // TODO: Switch back to --quiet when the hundreds of "replacing bundled version of" warnings disappear
  const { code } = shell.exec(NPM_CLI + ' install --silent');
  process.chdir(CWD);

  if (code !== 0) {
    throw new Error('An error occured while installing your NPM dependencies.');
  }
}

function runWebpack(shortName, configFiles) {
  let webpackConfig = {};

  configFiles.forEach(configFile => {
    const filePath = configFile.getPathInPackage();
    const data = configFile.getContentsAsString();

    readWebpackConfig(webpackConfig, shortName, configFile, filePath, data);
  });

  const usingDevServer =
    IS_DEBUG && !IS_BUILD &&
    shortName !== 'server' &&
    !PROCESS_ENV.IS_MIRROR; // Integration tests (velocity) should not use dev server

  prepareConfig(shortName, webpackConfig, usingDevServer);

  if (usingDevServer) {
    compileDevServer(shortName, configFiles, webpackConfig);
  } else {
    compile(shortName, configFiles, webpackConfig);
  }
}

function readWebpackConfig(webpackConfig, target, file, filePath, data) {
  let module = { exports: {} };
  var fileSplit = filePath.split('/');
  fileSplit.pop();

  const __dirname = _path.join(CWD, fileSplit.join(_path.sep));
  const process = {
    env: _.assign({}, PROCESS_ENV, { 'NODE_ENV': IS_DEBUG ? 'development' : 'production' })
  };

  const require = module => {
    if (module === 'webpack') {
      return Npm.require(module);
    }

    if (module === 'fs') {
      return _fs;
    }

    if (module === 'path') {
      return _path;
    }

    try {
      return NpmWorkaround.require(ROOT_WEBPACK_NPM + '/' + module);
    } catch(e) {}

    return NpmWorkaround.require(module);
  };

  const Meteor = {
    isServer: target === 'server',
    isClient: target !== 'server',
    isCordova: target === 'cordova'
  };

  try {
    eval(data);

    // Make sure the entry path is relative to the correct folder
    if (module.exports && !module.exports.context && module.exports.entry) {
      module.exports.context = __dirname;
    }
  } catch(e) {
    file.error({
      message: e.message
    });
  }

  webpackConfig = _.extend(webpackConfig, module.exports);
}

function prepareConfig(target, webpackConfig, usingDevServer) {
  if (!webpackConfig.output) {
    webpackConfig.output = {};
  }

  if (IS_DEBUG) {
    // source-map seems to be the only one working without eval that gives the accurate line of code
    // break call stack for unit testing and server otherwise
    webpackConfig.devtool = webpackConfig.devtool || 'source-map';

    if (!webpackConfig.devServer) {
      webpackConfig.devServer = {};
    }

    webpackConfig.devServer.protocol = webpackConfig.devServer.protocol || 'http:';
    webpackConfig.devServer.host = webpackConfig.devServer.host || 'localhost';
    webpackConfig.devServer.port = webpackConfig.devServer.port || 3500;
  } else {
    webpackConfig.devtool = webpackConfig.devtool || 'source-map';
  }

  if (usingDevServer) {
    let options = 'path=' + webpackConfig.devServer.protocol + '//' + webpackConfig.devServer.host + ':' + webpackConfig.devServer.port + '/__webpack_hmr';

    if (webpackConfig.hotMiddleware) {
      for (let key in webpackConfig.hotMiddleware) {
        const val = webpackConfig.hotMiddleware[key];
        options += '&' + key + '=';

        if (typeof val === 'boolean') {
          options += val ? 'true' : 'false';
        } else {
          options += val;
        }
      }
    }

    webpackConfig.entry = [].concat(
      'webpack-hot-middleware/client?' + options,
      webpackConfig.entry
    );
  }

  webpackConfig.output.path = '/memory/webpack';
  webpackConfig.output.publicPath = IS_DEBUG ? webpackConfig.devServer.protocol + '//' + webpackConfig.devServer.host + ':' + webpackConfig.devServer.port + '/assets/' : '/assets/';
  webpackConfig.output.filename = target + '.js';

  if (!webpackConfig.resolve) {
    webpackConfig.resolve = {};
  }

  // Use meteorhacks:npm to get packages from NPM
  if (typeof webpackConfig.resolve.root === 'string') {
    webpackConfig.resolve.root = [webpackConfig.resolve.root, ROOT_WEBPACK_NPM];
  } else if (typeof webpackConfig.resolve.root === 'object' && Array.isArray(webpackConfig.resolve.root)) {
    webpackConfig.resolve.root.push(ROOT_WEBPACK_NPM);
  } else {
    webpackConfig.resolve.root = [ROOT_WEBPACK_NPM];
  }

  if (!webpackConfig.resolveLoader) {
    webpackConfig.resolveLoader = {};
  }

  // Same for the loaders
  if (typeof webpackConfig.resolveLoader.root === 'string') {
    webpackConfig.resolveLoader.root = [webpackConfig.resolveLoader.root, ROOT_WEBPACK_NPM];
  } else if (typeof webpackConfig.resolveLoader.root === 'object' && Array.isArray(webpackConfig.resolveLoader.root)) {
    webpackConfig.resolveLoader.root.push(ROOT_WEBPACK_NPM);
  } else {
    webpackConfig.resolveLoader.root = [ROOT_WEBPACK_NPM];
  }

  if (!webpackConfig.plugins) {
    webpackConfig.plugins = [];
  }

  webpackConfig.plugins.unshift(new webpack.optimize.DedupePlugin());

  let definePlugin = {
    'process.env.NODE_ENV': JSON.stringify(IS_DEBUG ? 'development' : 'production'),
    'Meteor.isClient': JSON.stringify(target !== 'server'),
    'Meteor.isServer': JSON.stringify(target === 'server'),
    'Meteor.isCordova': JSON.stringify(target === 'cordova')
  };

  for (let name in PROCESS_ENV) {
    if (name === 'NODE_ENV') {
      continue;
    }

    definePlugin['process.env.' + name] = JSON.stringify(PROCESS_ENV[name]);
  }

  webpackConfig.plugins.unshift(new webpack.DefinePlugin(definePlugin));

  if (!IS_DEBUG) {
    // Production optimizations
    webpackConfig.plugins.push(new webpack.optimize.UglifyJsPlugin());
    webpackConfig.plugins.push(new webpack.optimize.OccurenceOrderPlugin());
  }

  if (usingDevServer) {
    webpackConfig.plugins.push(new webpack.HotModuleReplacementPlugin());
    webpackConfig.plugins.push(new webpack.NoErrorsPlugin());
  }
}

const compilers = {};

function compile(target, files, webpackConfig) {
  if (!configHashes[target] || _.some(files, file => !configHashes[target][file.getSourceHash()])) {
    compilers[target] = new webpack(webpackConfig);
    compilers[target].outputFileSystem = new MemoryFS();

    configHashes[target] = {};
    files.forEach(file => { configHashes[target][file.getSourceHash()] = true; });
  }

  const file = files[files.length - 1];
  const fs = compilers[target].outputFileSystem;
  let errors = null;

  Meteor.wrapAsync(done => {
    compilers[target].run(function(err, stats) {
      if (stats) {
        if (stats.hasErrors()) {
          errors = stats.toJson({ errorDetails: true }).errors;
        }

        // Save the chunk file names in the private folder of your project
        if (target === 'web') {
          webpackStats = stats.toJson({ chunks: true });

          // Only keep what we need for code splitting
          for (var key in webpackStats) {
            if (key !== 'assetsByChunkName' && key !== 'publicPath') {
              delete webpackStats[key];
            }
          }
        }
      }

      if (err) {
        if (errors) {
          errors.unshift(err);
        } else {
          errors = [err];
        }
      }

      done();
    });
  })();

  if (errors) {
    for (let error of errors) {
      file.error({
        message: error
      });
    }
  } else {
    const outputPath = path.join(webpackConfig.output.path, webpackConfig.output.filename);
    const sourceMapPath = `/memory/webpack/${target}.js.map`;

    // We have to fix the source map until Meteor update source-map:
    // https://github.com/meteor/meteor/pull/5411

    let sourceMapData;
    let sourceMap;

    // In case the source map isn't in a file
    try {
      sourceMapData = fs.readFileSync(sourceMapPath);
    } catch(e) {}

    if (sourceMapData) {
      sourceMap = JSON.parse(sourceMapData.toString());
      WebpackSourceMapFix(sourceMap);
    }

    let data = fs.readFileSync(outputPath).toString();

    if (target === 'server') {
      data = 'WebpackStats = ' + JSON.stringify(webpackStats) + ';\n' + data;
    }

    file.addJavaScript({
      path: target + '.js',
      data,
      sourceMap
    });

    if (!IS_DEBUG && target !== 'server') {
      addAssets(target, file, fs);
    }
  }
}

function addAssets(target, file, fs) {
  const assets = fs.readdirSync('/memory/webpack');

  for (let asset of assets) {
    if (asset !== target + '.js' && asset !== target + '.js.map') {
      const data = fs.readFileSync('/memory/webpack/' + asset);

      // Send CSS files to Meteor
      if (/\.css$/.test(asset)) {
        file.addStylesheet({
          path: 'assets/' + asset,
          data: data.toString()
        });
      } else {
        file.addAsset({
          path: 'assets/' + asset,
          data
        });
      }
    }
  }
}

function compileDevServer(target, files, webpackConfig) {
  const file = files[files.length - 1];

  if (webpackConfig.devServer) {
    file.addJavaScript({
      path: 'webpack.conf.js',
      data: '__WebpackDevServerConfig__ = ' + JSON.stringify(webpackConfig.devServer) + ';'
    });
  }

  if (configHashes[target] && _.every(files, file => configHashes[target][file.getSourceHash()])) {
    // Webpack is already watching the files, only restart if the config has changed
    return;
  }

  configHashes[target] = {};
  files.forEach(file => { configHashes[target][file.getSourceHash()] = true; });

  if (!devServerApp) {
    devServerApp = connect();
    devServerApp.use(cors());

    http.createServer(devServerApp).listen(webpackConfig.devServer.port);
  }

  if (devServerMiddleware[target]) {
    devServerMiddleware[target].close();

    devServerApp.stack.splice(
      devServerApp.stack.indexOf(devServerMiddleware[target]),
      1
    );

    devServerApp.stack.splice(
      devServerApp.stack.indexOf(devServerHotMiddleware[target]),
      1
    );
  }

  const compiler = webpack(webpackConfig);

  devServerMiddleware[target] = Npm.require('webpack-dev-middleware')(compiler, {
    noInfo: true,
    publicPath: webpackConfig.output.publicPath,
    stats: { colors: true },
    watchOptions: webpackConfig.watchOptions
  });

  devServerHotMiddleware[target] = Npm.require('webpack-hot-middleware')(compiler);

  devServerApp.use(devServerMiddleware[target]);
  devServerApp.use(devServerHotMiddleware[target]);
}

function filterFiles(files, name) {
  return files
    .filter(file => file.getBasename() === name)
    // Sort by shallower files
    .sort((file1, file2) => file1.getPathInPackage().split('/').length - file2.getPathInPackage().split('/').length);
}

function checkSymbolicLink() {
  // Make sure the symbolic link target is existing
  if (!fs.existsSync(ROOT_WEBPACK_NPM)) {
    mkdirp.sync(ROOT_WEBPACK_NPM);
  }

  // Babel plugins absolutely need this symbolic link to work
  if (!fs.existsSync(CWD + '/node_modules')) {
    try {
      fs.symlinkSync('.meteor/local/webpack-npm/node_modules', 'node_modules', 'dir');
    } catch(e) {
      console.log('-- Webpack Error! -- Cannot create symbolic link for node_modules to .meteor/local/webpack-npm/node_modules');

      if (IS_WINDOWS) {
        console.log('-- Webpack Error! -- It needs sufficient rights to create a symbolic link in your project');
        console.log('You might need to run meteor once with administrator rights or give your user the rights:');
        console.log('http://superuser.com/questions/104845/permission-to-make-symbolic-links-in-windows-7');
      }

      process.exit(1);
    }
  }
}

checkSymbolicLink();
