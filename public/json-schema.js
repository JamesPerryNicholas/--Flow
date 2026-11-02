(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlowSchema = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const child = (path, key) => (path === '$' ? '' : path) + '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const types = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
  const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'title', 'description']);
  const counts = ['minItems', 'maxItems', 'minProperties', 'maxProperties', 'minLength', 'maxLength'];
  const bounds = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];
  const fail = (path, message) => { throw new Error(path + ': ' + message); };
  function equal(left, right, tick) {
    const pending = [[left, right]];
    while (pending.length) {
      const [a, b] = pending.pop();
      if (tick) tick();
      if (a === b) continue;
      if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (const key of keys) {
        if (!own(b, key)) return false;
        pending.push([a[key], b[key]]);
      }
    }
    return true;
  }
  function compile(text) {
    if (typeof text !== 'string' || !text.trim()) fail('schema $', 'JSON Schema 必须是非空字符串');
    if (text.length > 50000) fail('schema $', '长度超过 50000 字符');
    let source;
    try { source = JSON.parse(text); } catch (error) { fail('schema $', 'JSON 解析失败：' + error.message); }
    // Bound the complete JSON tree, including annotation and enum/const values.
    const pending = [{ value: source, path: '$', depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const { value, path, depth } = pending.pop();
      if (++nodes > 1000) fail('schema ' + path, '节点数超过 1000');
      if (depth > 32) fail('schema ' + path, '深度超过 32');
      if (typeof value === 'number' && !Number.isFinite(value)) fail('schema ' + path, '数字必须有限');
      if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) pending.push({ value: value[key], path: child(path, key), depth: depth + 1 });
      }
    }
    function build(schema, path) {
      if (typeof schema === 'boolean') return schema;
      if (!isObject(schema)) fail('schema ' + path, 'Schema 必须是对象或布尔值');
      for (const key of Object.keys(schema)) if (!supported.has(key)) fail('schema ' + child(path, key), '不支持的关键字 ' + key);
      const node = { source: schema, properties: new Map() };
      const bad = (key, message) => fail('schema ' + child(path, key), message);
      if (own(schema, 'type')) {
        const list = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!list.length || list.some(type => !types.has(type)) || new Set(list).size !== list.length) bad('type', '必须是有效类型或非空且无重复的类型数组');
        node.types = list;
      }
      for (const key of ['title', 'description']) if (own(schema, key) && typeof schema[key] !== 'string') bad(key, '必须是字符串');
      for (const key of counts) if (own(schema, key) && (!Number.isInteger(schema[key]) || schema[key] < 0)) bad(key, '必须是非负整数');
      for (const key of bounds) if (own(schema, key) && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) bad(key, '必须是有限数字');
      if (own(schema, 'required')) {
        if (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string') || new Set(schema.required).size !== schema.required.length) bad('required', '必须是无重复的字符串数组');
        node.required = schema.required;
      }
      if (own(schema, 'enum')) {
        if (!Array.isArray(schema.enum) || !schema.enum.length) bad('enum', '必须是非空数组');
        for (let i = 0; i < schema.enum.length; i++) for (let j = 0; j < i; j++) if (equal(schema.enum[i], schema.enum[j])) bad('enum', '包含结构相同的重复值');
      }
      if (own(schema, 'properties')) {
        if (!isObject(schema.properties)) bad('properties', '必须是属性到 Schema 的对象');
        for (const key of Object.keys(schema.properties)) node.properties.set(key, build(schema.properties[key], child(child(path, 'properties'), key)));
      }
      for (const key of ['items', 'additionalProperties']) if (own(schema, key)) node[key] = build(schema[key], child(path, key));
      return node;
    }
    const compiled = build(source, '$');
    return function validate(value) {
      let visits = 0;
      function tick(path) {
        if (++visits > 100000) fail(path, '验证访问步数超过 100000');
      }
      // Check every input value, including unconstrained additional properties.
      // An ancestor set rejects cycles while allowing repeated shared objects.
      const ancestors = new Set();
      function json(value, path, depth) {
        tick(path);
        if (depth > 64) fail(path, '实例深度超过 64');
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
        if (typeof value === 'number') {
          if (!Number.isFinite(value)) fail(path, '数字必须有限');
          return;
        }
        if (typeof value !== 'object') fail(path, '必须是合法 JSON 值');
        if (ancestors.has(value)) fail(path, '实例包含循环引用');
        const prototype = Object.getPrototypeOf(value);
        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail(path, '必须是普通 JSON 对象');
        ancestors.add(value);
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) json(value[i], child(path, i), depth + 1);
        } else {
          for (const key of Object.keys(value)) json(value[key], child(path, key), depth + 1);
        }
        ancestors.delete(value);
      }
      json(value, '$', 0);
      function check(node, value, path) {
        tick(path);
        if (node === true) return;
        if (node === false) fail(path, '不允许此值（false Schema）');
        const schema = node.source;
        const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        if (node.types && !node.types.some(type => type === kind || (type === 'integer' && kind === 'number' && Number.isInteger(value)))) fail(path, '类型必须为 ' + node.types.join(' 或 '));
        if (own(schema, 'enum') && !schema.enum.some(item => equal(value, item, () => tick(path)))) fail(path, '值不在 enum 允许范围内');
        if (own(schema, 'const') && !equal(value, schema.const, () => tick(path))) fail(path, '值必须等于 const');
        function minimum(key, size) { if (own(schema, key) && size < schema[key]) fail(path, key + ' 要求至少 ' + schema[key]); }
        function maximum(key, size) { if (own(schema, key) && size > schema[key]) fail(path, key + ' 要求最多 ' + schema[key]); }
        if (kind === 'object') {
          const keys = Object.keys(value);
          minimum('minProperties', keys.length); maximum('maxProperties', keys.length);
          if (node.required) for (const key of node.required) if (!own(value, key)) fail(child(path, key), '缺少 required 属性');
          for (const key of keys) {
            if (node.properties.has(key)) check(node.properties.get(key), value[key], child(path, key));
            else if (own(node, 'additionalProperties')) check(node.additionalProperties, value[key], child(path, key));
          }
        } else if (kind === 'array') {
          minimum('minItems', value.length); maximum('maxItems', value.length);
          if (own(node, 'items')) for (let i = 0; i < value.length; i++) check(node.items, value[i], child(path, i));
        } else if (kind === 'string') {
          let length = 0;
          for (const codePoint of value) length++;
          minimum('minLength', length); maximum('maxLength', length);
        } else if (kind === 'number') {
          minimum('minimum', value); maximum('maximum', value);
          if (own(schema, 'exclusiveMinimum') && value <= schema.exclusiveMinimum) fail(path, 'exclusiveMinimum 要求大于 ' + schema.exclusiveMinimum);
          if (own(schema, 'exclusiveMaximum') && value >= schema.exclusiveMaximum) fail(path, 'exclusiveMaximum 要求小于 ' + schema.exclusiveMaximum);
        }
      }
      check(compiled, value, '$');
    };
  }
  return { compile: compile };
}));
