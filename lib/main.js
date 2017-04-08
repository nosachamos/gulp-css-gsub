(function (global, factory) {
    if (typeof define === "function" && define.amd) {
        define(["exports", "through2", "./replacer.js", "vinyl", "fs"], factory);
    } else if (typeof exports !== "undefined") {
        factory(exports, require("through2"), require("./replacer.js"), require("vinyl"), require("fs"));
    } else {
        var mod = {
            exports: {}
        };
        factory(mod.exports, global.through2, global.replacer, global.vinyl, global.fs);
        global.main = mod.exports;
    }
})(this, function (exports, through, Replacer, File, fs) {
    "use strict";

    Object.defineProperty(exports, "__esModule", {
        value: true
    });

    exports.default = config => {
        return through.obj((file, encoding, callback) => {
            config = Object.assign({
                cssIn: file.path
            }, config);

            var replacer, cssCode, jsCode;

            replacer = new Replacer.default(config);
            replacer.run();

            cssCode = replacer.generateCss(), jsCode = replacer.generateJs();

            fs.writeFileSync(config.jsOut, jsCode);

            file = new File({
                cwd: "/",
                base: "/",
                path: "/",
                contents: new Buffer(cssCode)
            });

            callback(null, file);
        });
    };
});