const test = require('node:test');
const assert = require('node:assert/strict');
const { compile } = require('../public/json-schema.js');
const validator = schema => compile(JSON.stringify(schema));

test('boolean schemas and strict supported keyword syntax', () => {
  assert.equal(validator(true)({ any: [1, null] }), undefined);
  assert.throws(() => validator(false)(1), /\$:.*false/);
  for (const schema of [{ $ref: '#' }, { format: 'email' }, { pattern: 'a' }, { type: [] }, { type: ['string', 'string'] }, { type: 'date' }, { items: [] }, { properties: [] }, { required: ['a', 'a'] }, { required: [1] }, { enum: [] }, { minLength: -1 }, { maxItems: 0.5 }, { minimum: '0' }, { exclusiveMaximum: true }, { title: 1 }, { description: null }, null, []]) {
    assert.throws(() => validator(schema), /schema /);
  }
  assert.throws(() => compile(''), /schema \$/);
  assert.throws(() => compile('{'), /schema \$/);
  assert.throws(() => compile('{"const":1e999}'), /schema \/const:.*有限/);
});

test('types, annotations, and type-specific keywords', () => {
  for (const [type, value] of [['null', null], ['boolean', false], ['object', {}], ['array', []], ['number', 1.5], ['integer', 1], ['string', 'x']]) assert.equal(validator({ type, title: '标题', description: '说明' })(value), undefined);
  assert.throws(() => validator({ type: 'integer' })(1.5), /类型/);
  assert.equal(validator({ type: ['integer', 'null'] })(null), undefined);
  assert.equal(validator({ minLength: 3, required: ['absent'], minimum: 3 })(false), undefined);
  assert.equal(validator({ type: 'number' })(2), undefined);
  assert.throws(() => validator({ type: 'string' })(1), /类型/);
});

test('objects, required outside properties, additional schema, and escaped pointers', () => {
  const check = validator({ type: 'object', properties: { known: { type: 'string' } }, required: ['outside'], additionalProperties: { type: 'integer' }, minProperties: 1, maxProperties: 3 });
  check({ known: 'x', outside: 2 });
  assert.throws(() => check({ known: 'x' }), /\/outside:.*required/);
  assert.throws(() => check({ outside: '2' }), /\/outside:.*类型/);
  assert.throws(() => validator({ additionalProperties: false })({ 'a/b~c': 1 }), /\/a~1b~0c:/);
  assert.throws(() => validator({ minProperties: 1 })({}), /minProperties/);
  assert.throws(() => validator({ maxProperties: 0 })({ a: 1 }), /maxProperties/);
});

test('dangerous-looking keys remain ordinary own properties', () => {
  const check = compile('{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"integer"}},"required":["__proto__","constructor"],"additionalProperties":false}');
  check(JSON.parse('{"__proto__":"safe","constructor":2}'));
  assert.throws(() => check({ constructor: 2 }), /\/__proto__:.*required/);
  assert.throws(() => check(JSON.parse('{"__proto__":3,"constructor":2}')), /\/__proto__:.*类型/);
  assert.equal({}.polluted, undefined);
});

test('array, Unicode code points, and numeric boundaries', () => {
  const check = validator({ items: { type: 'string', minLength: 1, maxLength: 1 }, minItems: 1, maxItems: 2 });
  check(['😀']);
  assert.throws(() => check([]), /minItems/);
  assert.throws(() => check(['a', 'b', 'c']), /maxItems/);
  assert.throws(() => check(['ab']), /\/0:.*maxLength/);
  assert.throws(() => check(['']), /minLength/);
  validator({ minimum: 1, maximum: 1 })(1);
  assert.throws(() => validator({ minimum: 1 })(0), /minimum/);
  assert.throws(() => validator({ maximum: 1 })(2), /maximum/);
  assert.throws(() => validator({ exclusiveMinimum: 1 })(1), /exclusiveMinimum/);
  assert.throws(() => validator({ exclusiveMaximum: 1 })(1), /exclusiveMaximum/);
});

test('enum and const compare structurally without object key ordering', () => {
  validator({ const: { a: [1, false], b: null } })({ b: null, a: [1, false] });
  validator({ enum: [1, '1', { a: 1 }] })({ a: 1 });
  assert.throws(() => validator({ enum: [1] })('1'), /enum/);
  assert.throws(() => validator({ const: [1, 2] })([2, 1]), /const/);
  assert.throws(() => validator({ enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }), /schema \/enum:.*重复/);
  assert.throws(() => validator({ enum: [0, -0] }), /重复/);
});

test('schema and instance resource limits and JSON compatibility', () => {
  assert.throws(() => compile(' '.repeat(50001)), /50000|非空/);
  assert.throws(() => compile('true' + ' '.repeat(49997)), /50000/);
  assert.throws(() => validator({ const: Array(1001).fill(0) }), /节点数/);
  let deepSchema = true;
  for (let i = 0; i < 34; i++) deepSchema = { items: deepSchema };
  assert.throws(() => validator(deepSchema), /深度/);
  const check = validator(true);
  let deep = 0;
  for (let i = 0; i < 65; i++) deep = [deep];
  assert.throws(() => check(deep), /深度/);
  assert.throws(() => check(Array(100001).fill(0)), /访问步数/);
  for (const value of [Infinity, NaN, undefined, new Date(), [undefined], Array(1)]) assert.throws(() => check(value), /有限|JSON/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => check(cyclic), /\/self:.*循环/);
  const shared = { a: 1 };
  check({ a: shared, b: shared });
});

test('validation never inserts defaults, coerces values, or edits input', () => {
  const value = { a: '2' };
  assert.throws(() => validator({ properties: { a: { type: 'integer' } } })(value), /类型/);
  assert.deepEqual(value, { a: '2' });
  assert.throws(() => validator({ default: 2 }), /不支持/);
});

test('browser UMD exposes the same synchronous compile API', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../public/json-schema.js'), 'utf8'), context);
  assert.equal(context.FlowSchema.compile('{"type":"integer"}')(2), undefined);
  assert.throws(() => context.FlowSchema.compile('{"type":"integer"}')('2'), /\$:.*类型/);
});
