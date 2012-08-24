/**
 * AmdCompiler compiles AMD JS files.
 */

/*jshint smarttabs:true, undef:true, node:true, latedef:true, curly:true, bitwise:true */
"use strict";

var jsp = require("uglify-js").parser;
var pro = require("uglify-js").uglify;
var fs = require("fs");
var util = require("util");
var path = require("path");

function createDirForFile(filePath) {
	if (!fs.existsSync(path.dirname(filePath))) {
		fs.mkdirSync(path.dirname(filePath));
	}

	return filePath;
}

// Converts Windows path to unix style
function toUnixPath(filePath) {
	return filePath.replace(/\\/g, '/');
}

// Walks the ast and executes the callback on each function call
function processFunctionCalls(ast, callback) {
	var stack = [];

	function walk(ast) {
		for (var i = 0; i < ast.length; i++) {
			if (ast[0] == "call") {
				if (callback(ast, stack) === false) {
					return;
				}
			}

			if (ast[i] instanceof Array) {
				stack.push(ast[i]);
				walk(ast[i]);
				stack.pop();
			}
		}
	}

	walk(ast);

	return ast;
}

// Parses the specified module file, and loads and injects any dependencies before.
function parseModuleFile(baseDir, filePath, options) {
	var modules = [], exposedModules = [], loadedPaths = {}, compiledAst;

	// Converts and module id to variable name
	function idStringToVariableName(id) {
		return  "_" + id.replace(/\./g, '_');
	}

	// Converts and module id to a file system path
	function resolveIdToPath(id) {
		if (options.excludeRootNamespaceFromPath) {
			id = id.replace(/^[^\/\.]+./, '');
		}

		id = id.replace(/\./g, '/');

		return path.join(baseDir, id + ".js");
	}

	// Returns true/false if the module is to be exposed to the global namespace or not
	function isExposed(module) {
		if (options.expose !== false) {
			// Specific modules to expose
			if (options.expose instanceof Array && options.expose.indexOf(module.id) == -1) {
				return false;
			}

			// Only modules that are public according to jsdoc
			if (options.expose == "public") {
				var matches, docCommentRegExp = /\/\*\*([\s\S]+?)\*\//g;

				for (matches = docCommentRegExp.exec(module.source); matches; matches = docCommentRegExp.exec(module.source)) {
					var docComment = matches[1];

					var classNameMatch = /\@class\s+(.+)/g.exec(docComment);
					if (classNameMatch) {
						if (classNameMatch[1] === module.id) {
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

	// Parses module files recursive and generates a compiled ast
	function processModuleFile(filePath) {
		var loaderData, source, preCompressedSource;

		filePath = toUnixPath(filePath);

		if (loadedPaths[filePath]) {
			return;
		} else {
			loadedPaths[filePath] = true;
		}

		// Load file using custom loader
		if (options.customLoader) {
			loaderData = options.customLoader(filePath);
		}

		// Use custom loader sources if found
		if (loaderData) {
			source = loaderData.source;
			preCompressedSource = source || loaderData.compressed;
		} else {
			source = "" + fs.readFileSync(filePath);
		}

		if (options.verbose) {
			console.log("Parsing module file: " + filePath);
		}

		var ast = processFunctionCalls(
			jsp.parse(preCompressedSource || source),

			function(call, stack) {
				if (call[1][1] == "define") {
					var args = call[2];

					// Get deps
					if (args[1][0] == "array") {
						args[1][1].forEach(function(arg) {
							var depId = arg[1];

							// Replace dep string with variable
							arg[0] = "name";
							arg[1] = idStringToVariableName(arg[1]);

							// Load dependecy
							processModuleFile(resolveIdToPath(depId));
						});
					}

					// Get id argument
					if (args[0][0] == "string") {
						var id = args[0][1];
						var idVarName = idStringToVariableName(args[0][1]);

						var module = {
							id: id,
							idVar: idVarName,
							filePath: filePath,
							source: source
						};

						modules.push(module);

						// Expose module to global namespace
						if (isExposed(module)) {
							exposedModules.push(module);
						}

						// Replace id with variable
						if (options.compressModuleIds !== false) {
							args[0][0] = "name";
							args[0][1] = idVarName;
						}
					}

					return false;
				}
			}
		);

		// Append file ast to compiled ast
		if (!compiledAst) {
			compiledAst = ast;
		} else {
			ast[1].forEach(function(op) {
				compiledAst[1].push(op);
			});
		}
	}

	if (filePath instanceof Array) {
		filePath.forEach(function(filePath) {
			require("glob").sync(filePath).forEach(processModuleFile);
		});
	} else {
		if (filePath.indexOf('*') != -1) {
			// Use glob if whildcard pattern
			require("glob").sync(filePath).forEach(processModuleFile);
		} else {
			// Parse single file
			processModuleFile(filePath);
		}
	}

	// Check if anything was parsed
	if (!compiledAst) {
		console.error("No input files found.");
		process.exit(-1);
	}

	// Inject variable lookup code
	if (options.compressModuleIds !== false) {
		var variableLookupCode = [];

		modules.forEach(function(module) {
			variableLookupCode.push([module.idVar, ["string", module.id]]);
		});

		compiledAst[1].unshift(["var", variableLookupCode]);
	}

	// Inject expose call if needed
	if (exposedModules.length > 0) {
		var exposedModuleList = [];

		exposedModules.forEach(function(module) {
			if (options.compressModuleIds !== false) {
				exposedModuleList.push(['name', module.idVar]);
			} else {
				exposedModuleList.push(['string', module.id]);
			}
		});

		compiledAst[1].push(['call', ['name', 'expose'], [['array', exposedModuleList]]]);
	}

	return {
		modules: modules,
		compiledAst: compiledAst,
		exposedModules: exposedModules
	};
}

// Writes an inline source version of the parsed modules to the outFile
function writeSourceVersion(parserData, outFile, options) {
	var source = "";

	// Generate source version
	parserData.modules.forEach(function(module) {
		source += "// Included from: " + module.filePath + "\n\n";
		source += module.source.trim() + "\n\n";
	});

	// Add expose call
	if (parserData.exposedModules.length > 0) {
		var exposeCall = "expose([";

		parserData.exposedModules.forEach(function(module, i) {
			exposeCall += (i > 0 ? ',' : '') + '"' + module.id + '"';
		});

		exposeCall += "]);";
		source += exposeCall;
	}

	var inlineLoaderSrc = "" + fs.readFileSync(path.join(__dirname, "AmdInlineLoader.js"));
	source = inlineLoaderSrc.replace(/\s*\$code\(\);/g, "\n\n" + source.trim());

	if (options.verbose) {
		console.log("Writing source version output to: " + toUnixPath(outFile));
	}

	fs.writeFileSync(createDirForFile(outFile), source);
}

// Writes and inline minified version of the parsed modules to the outFile
function writeCompressedVersion(parserData, outFile, options) {
	var ast;

	// Insert compiled code into AmdInlineLoader
	ast = processFunctionCalls(
		jsp.parse("" + fs.readFileSync(path.join(__dirname, "AmdInlineLoader.js"))),

		function(call, stack) {
			if (call[1][1] == "$code") {
				var parent = stack[stack.length - 3];

				// Remove function call
				parent.splice(parent.indexOf(stack[stack.length - 2]), 1);

				// Append compiled code after
				parent.push.apply(parent, parserData.compiledAst[1]);

				return false;
			}
		}
	);

	// Mangle and squeeze the ast
	if (options.compress !== false) {
		ast = pro.ast_lift_variables(ast);

		ast = pro.ast_mangle(ast, {
			mangle: true,
			toplevel: false,
			no_functions: false
		});

		ast = pro.ast_squeeze(ast);
	}

	if (options.verbose) {
		console.log("Writing compressed version to: " + toUnixPath(outFile));
	}

	fs.writeFileSync(createDirForFile(outFile), pro.gen_code(ast, {beautify: options.compress === false}));
}

// Writes and inline development version of the parsed modules to the outFile
function writeDevelopmentVersion(parserData, outFile, options) {
	var source = "";

	// Add expose call
	if (parserData.exposedModules.length > 0) {
		source += "\n\texpose([";

		parserData.exposedModules.forEach(function(module, i) {
			source += (i > 0 ? ',' : '') + '"' + module.id + '"';
		});

		source += "]);\n\n";
	}

	// Generate source version
	parserData.modules.forEach(function(module) {
		source += "\tload('" + toUnixPath(path.relative(path.dirname(outFile), module.filePath)) + "');\n";
	});

	var inlineLoaderSrc = "" + fs.readFileSync(path.join(__dirname, "AmdDevLoader.js"));
	inlineLoaderSrc = inlineLoaderSrc.replace(/\$fileName/g, path.basename(outFile));

	source += "\n\twriteScripts();";
	source = inlineLoaderSrc.replace(/\s*\$code\(\);/g, "\n\n\t" + source.trim());

	if (options.verbose) {
		console.log("Writing development version to: " + toUnixPath(outFile));
	}

	fs.writeFileSync(createDirForFile(outFile), source);
}

/**
 * Compile functions to be used by build scripts/cli.
 *
 * Usage:
 *  AmdCompiler.compile('js/namespace/Class.js', {
 *     baseDir: "js",
 *     outputSource: "mylib.js",
 *     outputMinified: "mylib.min.js",
 *     outputDev: "mylib.dev.js"
 *  });
 */
function compile(file, options) {
	var ast, baseDir;

	options = options || {};
	baseDir = options.baseDir || path.dirname(file);

	var parserData = parseModuleFile(baseDir, file, options);

	if (options.outputSource) {
		writeSourceVersion(parserData, options.outputSource, options);
	}

	if (options.outputMinified) {
		writeCompressedVersion(parserData, options.outputMinified, options);
	}

	if (options.outputDev) {
		writeDevelopmentVersion(parserData, options.outputDev, options);
	}
}

exports.compile = compile;
