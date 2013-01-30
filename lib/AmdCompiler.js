var UglifyJS = require("uglify-js");
var fs = require("fs");
var vm = require("vm");
var path = require("path");

var fileContentsCache = {};

function getFileContents(filePath) {
	if (!fileContentsCache[filePath]) {
		fileContentsCache[filePath] = "" + fs.readFileSync(filePath);
	}

	return fileContentsCache[filePath];
}

function createDirForFile(filePath) {
	if (!fs.existsSync(path.dirname(filePath))) {
		fs.mkdirSync(path.dirname(filePath));
	}

	return filePath;
}

function getFileModTime(filePath) {
	return fs.existsSync(filePath) ? fs.statSync(filePath).mtime.getTime() : 0;
}

function setFileModTime(filePath, options) {
	if (!options.force) {
		fs.utimesSync(filePath, new Date(options.lastMod), new Date(options.lastMod));
	}
}

function toUnixPath(filePath) {
	return filePath.replace(/\\/g, '/');
}

function removeDuplicates(array) {
	var filePaths = [], uniqueArray = [];

	array.forEach(function(module) {
		if (filePaths.indexOf(module.filePath) === -1) {
			filePaths.push(module.filePath);
			uniqueArray.push(module);
		}
	});

	uniqueArray.unshift(0, array.length);
	Array.prototype.splice.apply(array, uniqueArray);
}

function dump(astNode) {
	for (var name in UglifyJS) {
		var func = UglifyJS[name];

		if (typeof(func) == "function" && astNode instanceof func) {
			console.log(name);
		}
	}
}

function getPublicModules(modules) {
	var publicModules = [];
	modules.forEach(function(module) {
		if (module.isPublic) {
			publicModules.push(module);
		}
	});

	return publicModules;
}

function idToVarName(id) {
	return '__' + id.replace(/[\.\/]/g, '_');
}

function parseModules(options) {
	var modules = [], loadedPaths = {};

	// Returns true/false if the module is to be exposed to the global namespace or not
	function isExposed(id, source) {
		var exposeOptions = getLibFromId(id) || options;

		if (exposeOptions.expose !== false) {
			// Specific modules to expose
			if (exposeOptions.expose instanceof Array && exposeOptions.expose.indexOf(id) == -1) {
				return false;
			}

			// Only modules that are public according to jsdoc
			if (exposeOptions.expose == "public") {
				var matches, docCommentRegExp = /\/\*\*([\s\S]+?)\*\//g;

				for (matches = docCommentRegExp.exec(source); matches; matches = docCommentRegExp.exec(source)) {
					var docComment = matches[1];

					var classNameMatch = /\@class\s+(.+)/g.exec(docComment);
					if (classNameMatch) {
						if (classNameMatch[1] === id) {
							if (/@private/.test(docComment)) {
								return false;
							}
						}
					}
				}
			}

			return true;
		}

		return false;
	}

	// Returns library options if the id is part of a dependent lib
	function getLibFromId(id) {
		// Resolve id from dependent libraries
		for (var libName in options.libs) {
			var lib = options.libs[libName];

			if (id.indexOf(libName + '/') === 0) {
				return lib;
			}
		}
	}

	function resolveId(id) {
		id = id.replace(/\./g, '/');

		// Resolve external library id
		var lib = getLibFromId(id);
		if (lib) {
			if (lib.rootNS) {
				id = id.replace(lib.rootNS.replace(/\./g, '/').replace(/[\/]$/, '') + '/', '');
			}

			return toUnixPath(path.join(lib.baseDir, id + ".js"));
		}

		// Resolve internal id
		if (options.rootNS) {
			id = id.replace(options.rootNS.replace(/\./g, '/').replace(/[\/]$/, '') + '/', '');
		}

		return toUnixPath(path.join(options.baseDir, id + ".js"));
	}

	function resolvePath(filePath) {
		if (!/\.js$/.test(filePath)) { // seems to be an id or not js file
			filePath = resolveId(filePath);
		}

		if (/^[^\/\\]/.test(filePath)) { // do not resolve if begins with slash
			filePath = path.resolve(options.baseDir, filePath);
		}

		return toUnixPath(filePath);
	}

	function findFiles(filePath) {
		var files = [];

		// If array of paths or path expressions
		if (filePath instanceof Array) {
			filePath.forEach(function(filePath) {
				Array.prototype.push.apply(files, findFiles(filePath));
			});

			return files;
		}

		if (filePath.indexOf('*') != -1) {
			// Use glob if whildcard pattern
			Array.prototype.push.apply(files, require("glob").sync(filePath));
		} else {
			// Single file
			files.push(filePath);
		}

		return files;
	}

	function shouldLoadModule(id) {
		id = id.replace(/\./g, '/');

		for (var libName in options.libs) {
			if (id.indexOf(libName + '/') === 0) {
				return true;
			}
		}

		return !options.rootNS || id.indexOf(options.rootNS) === 0;
	}

	function parseModule(filePath) {
		var source;

		// module might be passed as object containing full source
		if (typeof filePath === 'object') {
			source = filePath.source || '';
			filePath = filePath.filePath;
		}

		filePath = toUnixPath(filePath);
		//filePath = resolvePath(filePath);

		if (loadedPaths[filePath]) {
			return;
		}

		loadedPaths[filePath] = true;

		if (typeof filePath === 'string' && !source) {
			source = getFileContents(filePath);
		}

		if (options.version) {
			source = source.replace(/@@version@@/g, options.version);
		}

		if (options.releaseDate) {
			source = source.replace(/@@releaseDate@@/g, options.releaseDate);
		}

		if (options.verbose) {
			console.log("Parsing module file: " + filePath);
		}

		var mtime = getFileModTime(filePath);
		if (!options.lastMod || mtime > options.lastMod) {
			options.lastMod = mtime;
		}

		try {
			vm.runInNewContext(source, {
				define: function(id, deps, func) {
					deps.forEach(function(id) {
						var filePath = resolveId(id);

						if (options.moduleOverrides && options.moduleOverrides[id]) {
							filePath = options.moduleOverrides[id];
						}

						if (!loadedPaths[filePath] && shouldLoadModule(id)) {
							parseModule(filePath);
						}
					});

					modules.push({
						filePath: filePath,
						source: source,
						id: id,
						deps: deps,
						isPublic: isExposed(id, source)
					});
				}
			});
		} catch(ex) {
			console.info(ex);
			process.exit(1);
		}
	}

	findFiles(options.from).forEach(parseModule);

	if (options.force) {
		options.lastMod = -1;
	}

	return modules;
}

function mangleModuleIds(body) {
	var ast, value, args, elements, moduleIds = [], lookup = {};

	for (var i = 0; i < body.length; i++) {
		ast = body[i].body;

		if (ast instanceof UglifyJS.AST_Call && ast.expression.name === "define") {
			args = ast.args;

			if (args.length == 3) {
				if (args[0] instanceof UglifyJS.AST_String) {
					var id = args[0].value, varName = idToVarName(id);

					args[0] = new UglifyJS.AST_SymbolVar({
						name: varName
					});

					if (!lookup[id]) {
						moduleIds.push({
							id: id,
							varName: varName
						});

						lookup[id] = true;
					}
				}

				if (args[1] instanceof UglifyJS.AST_Array) {
					elements = args[1].elements;

					for (var ei = 0; ei < elements.length; ei++) {
						if (elements[ei] instanceof UglifyJS.AST_String) {
							var depId = elements[ei].value;

							elements[ei] = new UglifyJS.AST_SymbolVar({
								name: idToVarName(depId)
							});

							if (!lookup[depId]) {
								moduleIds.push({
									id: depId,
									varName: idToVarName(depId)
								});

								lookup[depId] = true;
							}
						}
					}
				} else {
					elements = [];
				}

				if (args[2] instanceof UglifyJS.AST_Function) {
					if (elements.length !== args[2].argnames.length) {
						throw new Error("Module defs are not equal to define function args");
					}
				}
			}
		}
	}

	var moduleVarDef = [];

	moduleIds.forEach(function(module) {
		moduleVarDef.push(new UglifyJS.AST_VarDef({
			name : new UglifyJS.AST_SymbolVar({
				name: module.varName
			}),

			value: new UglifyJS.AST_String({
				value: module.id
			})
		}));
	});

	body.unshift(new UglifyJS.AST_Var({
		definitions: moduleVarDef
	}));
}

function exposeModules(body, publicModules) {
	var moduleIdArray = [];

	publicModules.forEach(function(module) {
		moduleIdArray.push(new UglifyJS.AST_SymbolVar({name: idToVarName(module.id)}));
	});

	body.push(new UglifyJS.AST_SimpleStatement({
		body: new UglifyJS.AST_Call({
			expression: new UglifyJS.AST_SymbolRef({name: "expose"}),
			args: [new UglifyJS.AST_Array({elements: moduleIdArray})]
		})
	}));
}

function compileMinified(modules, options) {
	var toplevel, loader, innerScope, compressor, source;

	removeDuplicates(modules); // make sure items do not repeat (might happen when modules is constructed manually)

	if (options.lastMod != getFileModTime(options.outputMinified)) {
		modules.forEach(function(module) {
			toplevel = UglifyJS.parse(module.source, {
				filename: module.filePath,
				toplevel: toplevel
			});
		});

		mangleModuleIds(toplevel.body);
		exposeModules(toplevel.body, getPublicModules(modules));

		// Inject code into loader
		loader = UglifyJS.parse(getFileContents(path.join(__dirname, "AmdInlineLoader.js")));
		innerScope = loader.body[0].body.expression.body;
		innerScope.splice(-1);
		toplevel.body.forEach(function(stmt) {
			innerScope.push(stmt);
		});
		toplevel = loader;
		toplevel.figure_out_scope();

		// Compress and mangle
		if (options.compress) {
			compressor = UglifyJS.Compressor({unused: false}); // TODO: Fix this
			toplevel = toplevel.transform(compressor);
			toplevel.figure_out_scope();
			toplevel.compute_char_frequency();
			toplevel.mangle_names();
		}

		source = toplevel.print_to_string({ascii_only: true, beautify: false});

		if (options.version && options.releaseDate) {
			source = "// " + options.version + " (" + (options.releaseDate) + ")\n" + source;
		}

		if (options.verbose) {
			console.log("Writing minified version output to: " + toUnixPath(options.outputMinified));
		}

		fs.writeFileSync(createDirForFile(options.outputMinified), source);
		setFileModTime(options.outputMinified, options);
	}
}

function compileSource(modules, options) {
	removeDuplicates(modules); // make sure items do not repeat (might happen when modules is constructed manually)

	if (options.lastMod != getFileModTime(options.outputSource)) {
		var source = "";
		var outFile = options.outputSource;

		// Write expose call for public modules
		var publicModules = getPublicModules(modules);
		if (publicModules.length > 0) {
			var exposeCall = "expose([";

			publicModules.forEach(function(module, i) {
				exposeCall += (i > 0 ? ',' : '') + '"' + module.id + '"';
			});

			exposeCall += "]);";
			source += exposeCall;
		}

		// Generate source version
		modules.forEach(function(module) {
			source += "// Included from: " + module.filePath + "\n\n";
			source += module.source.trim() + "\n\n";

			if (options.globalModules && options.globalModules[module.id]) {
				source += 'var ' + options.globalModules[module.id] + ' = modules["' + module.id + '"];\n\n';
			}
		});

		var inlineLoaderSrc = getFileContents(path.join(__dirname, "AmdInlineLoader.js"));
		source = inlineLoaderSrc.replace(/\s*\$code\(\);/g, function() {
			return "\n\n" + source.trim();
		});

		if (options.verbose) {
			console.log("Writing source version output to: " + toUnixPath(options.outputSource));
		}

		if (options.version && options.releaseDate) {
			source = "// " + options.version + " (" + (options.releaseDate) + ")\n\n" + source;
		}

		fs.writeFileSync(createDirForFile(options.outputSource), source);
		setFileModTime(options.outputSource, options);
	}
}

function compileDevelopment(modules, options) {
	var source = "";

	removeDuplicates(modules); // make sure items do not repeat (might happen when modules is constructed manually)

	if (options.lastMod != getFileModTime(options.outputDev)) {
		// Add expose call
		var publicModules = getPublicModules(modules);
		if (publicModules.length > 0) {
			source += "\n\texpose([";

			publicModules.forEach(function(module, i) {
				source += (i > 0 ? ',' : '') + '"' + module.id + '"';
			});

			source += "]);\n\n";
		}

		if (options.globalModules) {
			source += "\tglobals = " + JSON.stringify(options.globalModules) + ";\n\n";
		}

		// Generate source version
		modules.forEach(function(module) {
			if (fs.existsSync(module.filePath)) {
				source += "\tload('" + toUnixPath(path.relative(path.dirname(options.outputDev), module.filePath)) + "');\n";
			} else if (module.source) {
				source += "\thtml += '<script type=\"text/javascript\">" + module.source.replace(/([\\\'\^])/g, "\\$1").replace(/([\n]+)/g, '\\n').replace(/([\t]+)/g, '\\t') + "</script>';\n";
				source += '\tmoduleCount++;\n';
			}
		});

		var inlineLoaderSrc = getFileContents(path.join(__dirname, "AmdDevLoader.js"));
		inlineLoaderSrc = inlineLoaderSrc.replace(/\$fileName/g, function() {
			return path.basename(options.outputDev);
		});

		source += "\n\twriteScripts();";
		source = inlineLoaderSrc.replace(/\s*\$code\(\);/g, function() {
			return "\n\n\t" + source.trim();
		});

		if (options.verbose) {
			console.log("Writing development version to: " + toUnixPath(options.outputDev));
		}

		fs.writeFileSync(createDirForFile(options.outputDev), source);
		setFileModTime(options.outputDev, options);
	}
}

/**
 * Compile functions to be used by build scripts/cli.
 *
 * Usage:
 *  AmdCompiler.compile({
 *     from: "js/namespace/Class.js",
 *     baseDir: "js",
 *     outputSource: "mylib.js",
 *     outputMinified: "mylib.min.js",
 *     outputDev: "mylib.dev.js"
 *  });
 */
function compile(options) {
	var modules;

	modules = parseModules(options);
	compileMinified(modules, options);
	compileSource(modules, options);
	compileDevelopment(modules, options);
}

exports.compile = compile;
exports.parseModules = parseModules;
exports.compileMinified = compileMinified;
exports.compileSource = compileSource;
exports.compileDevelopment = compileDevelopment;
