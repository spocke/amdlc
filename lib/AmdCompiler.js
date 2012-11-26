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
		if (options.expose !== false) {
			// Specific modules to expose
			if (options.expose instanceof Array && options.expose.indexOf(id) == -1) {
				return false;
			}

			// Only modules that are public according to jsdoc
			if (options.expose == "public") {
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

	function resolveIdToPath(id) {
		id = id.replace(/\./g, '/');

		if (options.rootNS) {
			id = id.replace(options.rootNS.replace(/\./g, '/').replace(/[\/]$/, '') + '/', '');
		}

		return toUnixPath(path.join(options.baseDir, id + ".js"));
	}

	function parseModule(filePath) {
		var source;

		filePath = toUnixPath(filePath);
		if (loadedPaths[filePath]) {
			return;
		}

		loadedPaths[filePath] = true;

		source = getFileContents(filePath);

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

		vm.runInNewContext(source, {
			define: function(id, deps, func) {
				deps.forEach(function(id) {
					var filePath = resolveIdToPath(id);

					if (options.moduleOverrides && options.moduleOverrides[id]) {
						filePath = options.moduleOverrides[id];
					}

					if (id.indexOf(options.rootNS) === 0 && !loadedPaths[filePath]) {
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
	}

	if (options.from instanceof Array) {
		options.from.forEach(function(filePath) {
			require("glob").sync(filePath).forEach(parseModule);
		});
	} else {
		if (options.from.indexOf('*') != -1) {
			// Use glob if whildcard pattern
			require("glob").sync(options.from).forEach(parseModule);
		} else {
			// Parse single file
			parseModule(options.from);
		}
	}

	if (options.force) {
		options.lastMod = -1;
	}

	return modules;
}

function mangleModuleIds(body) {
	var ast, value, args, elements, moduleIds = [];

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

					moduleIds.push({id: id, varName: varName});
				}

				if (args[1] instanceof UglifyJS.AST_Array) {
					elements = args[1].elements;

					for (var ei = 0; ei < elements.length; ei++) {
						if (elements[ei] instanceof UglifyJS.AST_String) {
							elements[ei] = new UglifyJS.AST_SymbolVar({
								name: idToVarName(elements[ei].value)
							});
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
	if (options.lastMod != getFileModTime(options.outputSource)) {
		var source = "";
		var outFile = options.outputSource;

		// Generate source version
		modules.forEach(function(module) {
			source += "// Included from: " + module.filePath + "\n\n";
			source += module.source.trim() + "\n\n";

			if (options.globalModules && options.globalModules[module.id]) {
				source += 'var ' + options.globalModules[module.id] + ' = modules["' + module.id + '"];\n\n';
			}
		});

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
			source += "\tload('" + toUnixPath(path.relative(path.dirname(options.outputDev), module.filePath)) + "');\n";
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
