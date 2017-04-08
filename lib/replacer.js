var esprima = require("esprima"),
    css = require("css"),
    estraverse = require("estraverse"),
    escodegen = require("escodegen"),
    fs = require("fs");

export default class Replacer {

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
            replace: this.emptyFn,
            replaceAll: false
        }, config);

        this.key = "a0";
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
        while (true) {
            let className = this.counter.toString(34);
            if (this.cssText.match(new RegExp('\\b\\.' + className + '\\b', 'gi'))) {
                this.counter++;
            }
        }

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
            if (rule.type != "rule") continue;

            var selectors = rule.selectors.join(" ").match(regexp);

            if (selectors) classes = classes.concat(selectors.join(" ").replace(/\./g, "").split(" "));
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
                key = this.succ(key);
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
            if (rule.type != "rule") continue;

            var newSelectors = [];

            for (var j = 0, selector; selector = rule.selectors[j]; j++) {
                selector = selector.replace(regexp, function (a) {
                    return "." + replacements.items[a.replace(".", "")];
                });

                if (/undefined/.test(selector))
                    // it can mean two things:
                    // 1. there is a CSS rule which is not used in js file.
                    // 2. it's a bug in gulp-css-gsub :)
                    console.log("undefined in " + selector + " === " + rule.selectors.join(" "));else newSelectors.push(selector);
            }

            if (newSelectors.length == rule.selectors.length) rule.selectors = newSelectors;else rule.selectors = []; // remove rule, because of unused selector.
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