var amdCompiler = require("./AmdCompiler");
var path = require("path");
var fs = require("fs");

var argv = process.argv;

function isEmpty() {
	return argv.length <= 2;
}

function get(name, required, defaultValue) {
	var names = name.split(/[, ]/);

	if (!has(name) && required) {
		console.error("Error: --" + name + " is required.");
		process.exit(0);
		return;
	}

	for (var i = 0; i < names.length; i++) {
		var index = argv.indexOf('--' + names[i]);

		if (index !== -1) {
			var value = argv[index + 1];

			// Check if the value for the option is missing
			if (required && (typeof(value) == "undefined" || /^--/.test(value))) {
				console.error("Error: --" + names[i] + " requires an argument.");
				process.exit(0);
				return;
			}

			return value;
		}
	}

	if (typeof(defaultValue) !== "undefined") {
		return defaultValue;
	}
}

function has(name) {
	var names = name.split(/[, ]/);

	for (var i = 0; i < names.length; i++) {
		if (argv.indexOf('--' + names[i]) !== -1) {
			return true;
		}
	}

	return false;
}

function item(offset) {
	offset = argv.length - 1 - offset;

	if (typeof(argv[offset]) != "undefined" && !/^--/.test(argv[offset])) {
		return argv[offset];
	}
}

// Output help if specified or missing arguments
if (has('h,help') || isEmpty()) {
	console.log([
		"Usage: amdlc [options] <input file/glob pattern> <output file>",
		"",
		"Options:",
		"  --quiet              no output",
		"  --include-root-ns    include root namespace from path resolve",
		"  --basedir            basedir to look for modules for example src/js"
	].join("\n"));

	process.exit(1);
}

var inputFile = item(1);
var outputFile = item(0);

if (!fs.existsSync(path.dirname(outputFile))) {
	fs.mkdirSync(path.dirname(outputFile));
}

amdCompiler.compile(item(1), {
	baseDir: get('basedir', true),
	compress: true,
	expose: "public",
	excludeRootNamespaceFromPath: !get('include-root-ns'),
	verbose: !get('quiet'),
	outputSource: outputFile,
	outputMinified: path.join(path.dirname(outputFile), path.basename(outputFile, path.extname(outputFile)) + ".min.js"),
	outputDev: path.join(path.dirname(outputFile), path.basename(outputFile, path.extname(outputFile)) + ".dev.js")
});
