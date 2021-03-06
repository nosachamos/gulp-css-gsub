(function (global, factory) {
    if (typeof define === "function" && define.amd) {
        define(["exports", "esprima", "css", "estraverse", "escodegen", "fs"], factory);
    } else if (typeof exports !== "undefined") {
        factory(exports, require("esprima"), require("css"), require("estraverse"), require("escodegen"), require("fs"));
    } else {
        var mod = {
            exports: {}
        };
        factory(mod.exports, global.esprima, global.css, global.estraverse, global.escodegen, global.fs);
        global.replacer = mod.exports;
    }
})(this, function (exports, esprima, css, estraverse, escodegen, fs) {
    "use strict";

    Object.defineProperty(exports, "__esModule", {
        value: true
    });
    class Replacer {

        /**
         * @param {Object} config
         * @param {String} config.prefix Used when CSS classes look like "{prefix}profile" "d-profile"
         * @param {RegExp} config.regexp Used when CSS classes use non-prefix declaration format.
         * @param {Function} config.replace
         * Function that will be called for each node from JS-AST. It's used when regexp is not enough and you need to
         * replace CSS classes based on some specific rules.
         * For example:
         * @example
         * In Sencha Touch / ExtJS, when you define a component:
         *  Ext.define("MyComponent", {
         *      extend: "Ext.Component",
         *      config: {
         *          baseCls: "d-my-component"
         *      }
         *  });
         * ST/ExtJS will construct an additional CSS class "d-my-component-inner" using a rule #baseCls + '-inner', so
         * when you replace #baseCls you need to replace "d-my-component-inner" with a minimized version of #baseCls plus
         * '-inner' string to avoid bugs. So it could look like this:
         * "d-my-component" -> "a0"
         * "d-my-component-inner" -> "a0-inner"
         *
         * @param {Boolean} replaceAll Should be true to rename all CSS classes including those classes that couldn't be
         *                             found in js-file (probably unused).
         */
        constructor(config) {
            this.counter = 0;
            this.config = Object.assign({
                regexp: null,
                prefix: null,
                replacementsOutput: null,
                replace: this.emptyFn,
                replaceAll: false
            }, config);

            this.key = "_";
            this.replacements = {
                count: 0,
                items: {}
            };
        }

        /**
         * a reusable empty function
         */
        emptyFn() {}

        /**
         * @param {String}
         * @return {String}
         */
        succ() {
            let className = 'no-match';
            while (true) {
                className = this.counter.toString(34);
                // only accept valid class names (cannot start with a digit, or a hyphen followed by a digit)
                if (!/^([a-z_]|-[a-z_-])[a-z\d_-]*$/i.test(className)) {
                    this.counter++;
                    continue;
                }

                let regex = '\\b\\.' + className + '\\b';

                if (this.cssText.search(new RegExp(regex, 'gi')) > -1) {
                    this.counter++;
                } else {
                    break;
                }
            }
            this.counter++;

            return className;
        }

        /**
         * an entry point.
         */
        run() {
            this.openFiles();
            this.initFilesAst();
            this.parseCssRules();
            this.replace();

            if (this.config.replacementsOutput) {
                fs.writeFile(this.config.replacementsOutput, JSON.stringify(this.replacements, null, 2), 'utf-8');
            }
        }

        /**
         * simply reads the content of CSS and js file.
         */
        openFiles() {
            this.cssText = fs.readFileSync(this.config.cssIn, "utf8");
            this.jsText = fs.readFileSync(this.config.jsIn, "utf8");
        }

        /**
         * initializes AST for both CSS and JS.
         */
        initFilesAst() {
            this.cssAst = css.parse(this.cssText);
            this.jsAst = esprima.parse(this.jsText);
        }

        /**
         * @return {RegExp} regexp to match CSS classes like: .d-user-profile
         */
        generateCssClsRegExp() {
            var config = this.config;

            if (config.prefix) return new RegExp("\\.(?:" + config.prefix + "){1}[0-9a-zA-Z\\-_]+", "g");

            if (config.regexp) return new RegExp(config.regexp.toString().replace("\/", "\/."));

            return new RegExp("\\.[0-9a-zA-Z\\-_]+", "g");
        }

        /**
         * @return {RegExp} regexp to match CSS classes like: <div class="d-user-profile"></div>
         */
        generateJsClsRegExp() {
            var config = this.config;

            if (config.prefix) return new RegExp("(\\b" + config.prefix + "[0-9a-zA-Z\-_]+)", "g");

            if (config.regexp) return config.regexp;

            return new RegExp(this.classes.join("|"), "g");
        }

        /**
         * parses CSS file to extract all CSS class names in required order.
         */
        parseCssRules() {
            var config = this.config,
                regexp = this.generateCssClsRegExp(),
                classes = [];

            this.rules = this.cssAst.stylesheet.rules;

            for (var i = 0, rule; rule = this.rules[i]; i++) {
                if (rule.type == "media") {
                    // for (var j = 0, mediaRule; mediaRule = rule.rules[j]; j++) {
                    //     if (mediaRule.type != "rule") continue;
                    //     var selectors = mediaRule.selectors.join(" ").match(regexp);
                    //     if (selectors) classes = classes.concat(selectors.join(" ").replace(/\./g, "").split(" "));
                    // }

                } else {
                    if (rule.type != "rule") continue;

                    var selectors = rule.selectors.join(" ").match(regexp);

                    if (selectors) classes = classes.concat(selectors.join(" ").replace(/\./g, "").split(" "));
                }
            }

            this.classes = classes.sort(function (a, b) {
                return b.length - a.length;
            }).filter(function (cls, pos) {
                return classes.indexOf(cls) == pos;
            });
        }

        /**
         * replaces CSS class names in JS AST
         * @return {Replacer}
         */
        replace() {
            var config = this.config,
                replace = config.replace;

            estraverse.traverse(this.jsAst, {
                enter: (node, parent) => {
                    if (replace.call(this, node, parent) === false) return;

                    if (node.type != "Literal") return;

                    if (typeof node.value != "string") return;

                    this.replaceItem(node);
                }
            });

            if (config.replaceAll) this.replaceAll();

            return this;
        }

        /**
         * Replaces a CSS class name in string literal node with it's minimized version.
         * @param {Object} node String literal node.
         * @return {undefined}
         */
        replaceItem(node) {
            var value = node.value,
                key = this.key,
                replacements = this.replacements,
                regexp = this.generateJsClsRegExp(),
                matches = value.match(regexp);

            if (!matches) return;

            for (var i = 0, match; match = matches[i]; i++) {
                if (!replacements.items[match]) {
                    replacements.items[match] = key;
                    key = this.succ();
                }
            }

            value = value.replace(regexp, function (a) {
                replacements.count++;
                return replacements.items[a];
            });

            node.value = value;
            this.key = key;
        }

        /**
         * peforms replacements for all unmatched CSS class names.
         * @return {undefined}
         */
        replaceAll() {
            var replacements = this.replacements,
                key = this.key;

            this.classes.forEach(cls => {
                if (!replacements.items[cls]) {
                    replacements.items[cls] = key;
                    key = this.succ();
                    replacements.count++;
                }
            });
        }

        /**
         * @returns {String} Resulting CSS code with replacements based on CSS AST.
         */
        generateCss() {
            var replacements = this.replacements,
                regexp = this.generateCssClsRegExp();

            for (var i = 0, rule; rule = this.rules[i]; i++) {
                if (rule.type == "media") {
                    for (var z = 0, mediaRule; mediaRule = rule.rules[z]; z++) {
                        if (mediaRule.type != "rule") continue;

                        var newSelectors = [];
                        var self = this;

                        for (var j = 0, selector; selector = mediaRule.selectors[j]; j++) {
                            selector = selector.replace(regexp, function (a) {
                                var clazz = a.replace(".", "");
                                if (!replacements.items[clazz] && mediaRule.selectors.join(" ").indexOf(':not') > -1) {
                                    replacements.items[clazz] = self.succ();
                                }
                                return "." + replacements.items[clazz];
                            });

                            if (/undefined/.test(selector)) {
                                // it can mean two things:
                                // 1. there is a CSS rule which is not used in js file.
                                // 2. it's a bug in gulp-css-gsub :)
                                // console.log("undefined in " + selector + " === " + mediaRule.selectors.join(" "))
                            } else {
                                newSelectors.push(selector);
                            }
                        }

                        if (newSelectors.length == mediaRule.selectors.length) {
                            mediaRule.selectors = newSelectors;
                        } else {
                            mediaRule.selectors = []; // remove mediaRule, because of unused selector.
                        }
                    }
                } else {
                    if (rule.type != "rule") continue;

                    var newSelectors = [];
                    var self = this;

                    for (var j = 0, selector; selector = rule.selectors[j]; j++) {
                        selector = selector.replace(regexp, function (a) {
                            var clazz = a.replace(".", "");
                            if (!replacements.items[clazz] && rule.selectors.join(" ").indexOf(':not') > -1) {
                                replacements.items[clazz] = self.succ();
                            }
                            return "." + replacements.items[clazz];
                        });

                        if (/undefined/.test(selector)) {
                            // it can mean two things:
                            // 1. there is a CSS rule which is not used in js file.
                            // 2. it's a bug in gulp-css-gsub :)
                            // console.log("undefined in " + selector + " === " + rule.selectors.join(" "))
                        } else {
                            newSelectors.push(selector);
                        }
                    }

                    if (newSelectors.length == rule.selectors.length) {
                        rule.selectors = newSelectors;
                    } else {
                        rule.selectors = []; // remove rule, because of unused selector.
                    }
                }
            }

            return css.stringify(this.cssAst);
        }

        /**
         * @returns {String} a resulting JS code with replacements based on JS AST.
         */
        generateJs() {
            return escodegen.generate(this.jsAst);
        }

        /**
         * @return {Number} number of replacments.
         */
        getReplacementsCount() {
            return this.replacements.count;
        }
    }
    exports.default = Replacer;
});