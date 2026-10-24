'use strict';

// These names resolve in the pinned vendor scope when the static closures are
// served as part of its script, rather than when this host module is loaded.
/* global throwBindingError, usesDestructorStack, runDestructors, createNamedFunction,
          emval_lookupTypes, reflectConstruct, emval_returnValue, emval_addMethodCaller */

const { createHash } = require('node:crypto');

const OCCT_GLUE_SHA256 = '3fb44ce11d00611f9b3f3c5775d520ebab48930c1f08279b7b1316f05f0d3379';

// Replay-only static embind invokers, adapted from Emscripten 3.1.69's
// DYNAMIC_EXECUTION=0 branches (MIT / University of Illinois-NCSA; the license
// is preserved in vendor/occt-import/EMSCRIPTEN-LICENSE.txt):
// https://github.com/emscripten-core/emscripten/blob/3.1.69/src/embind/embind.js
// https://github.com/emscripten-core/emscripten/blob/3.1.69/src/embind/emval.js
// The pinned build has ASSERTIONS=0, ASYNCIFY=0 and EMBIND_AOT=0. These are
// ordinary closures, not an evaluator for generated strings or model data.
/* eslint-disable no-redeclare -- Preserve the pinned static invoker's function-scoped var reuse. */
function craftInvokerFunction(
  humanName,
  argTypes,
  classType,
  cppInvokerFunc,
  cppTargetFunc,
  isAsync,
) {
  if (argTypes.length < 2 || isAsync)
    throwBindingError('Unexpected static STEP binding signature.');
  var isClassMethodFunc = argTypes[1] !== null && classType !== null;
  var needsDestructorStack = usesDestructorStack(argTypes);
  var returns = argTypes[0].name !== 'void';
  var expectedArgCount = argTypes.length - 2;
  var argsWired = new Array(expectedArgCount);
  var invokerFuncArgs = [];
  var destructors = [];
  var invokerFn = function (...args) {
    destructors.length = 0;
    var thisWired;
    invokerFuncArgs.length = isClassMethodFunc ? 2 : 1;
    invokerFuncArgs[0] = cppTargetFunc;
    if (isClassMethodFunc) {
      thisWired = argTypes[1].toWireType(destructors, this);
      invokerFuncArgs[1] = thisWired;
    }
    for (var i = 0; i < expectedArgCount; ++i) {
      argsWired[i] = argTypes[i + 2].toWireType(destructors, args[i]);
      invokerFuncArgs.push(argsWired[i]);
    }
    var rv = cppInvokerFunc(...invokerFuncArgs);
    if (needsDestructorStack) {
      runDestructors(destructors);
    } else {
      for (var i = isClassMethodFunc ? 1 : 2; i < argTypes.length; i++) {
        var param = i === 1 ? thisWired : argsWired[i - 2];
        if (argTypes[i].destructorFunction !== null) argTypes[i].destructorFunction(param);
      }
    }
    if (returns) return argTypes[0].fromWireType(rv);
  };
  return createNamedFunction(humanName, invokerFn);
}

/* eslint-enable no-redeclare */

function staticMethodCaller(argCount, argTypes, kind) {
  var types = emval_lookupTypes(argCount, argTypes);
  var retType = types.shift();
  argCount--;
  var argN = new Array(argCount);
  var invokerFunction = (obj, func, destructorsRef, args) => {
    var offset = 0;
    for (var i = 0; i < argCount; ++i) {
      argN[i] = types[i].readValueFromPointer(args + offset);
      offset += types[i].argPackAdvance;
    }
    var rv = kind === 1 ? reflectConstruct(func, argN) : func.apply(obj, argN);
    return emval_returnValue(retType, destructorsRef, rv);
  };
  var functionName = `methodCaller<(${types.map(t => t.name).join(', ')}) => ${retType.name}>`;
  return emval_addMethodCaller(createNamedFunction(functionName, invokerFunction));
}

let adapted;
function recordedOcctGlue(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (createHash('sha256').update(bytes).digest('hex') !== OCCT_GLUE_SHA256)
    throw Error('Recorded STEP glue integrity check failed.');
  if (adapted) return adapted;
  let text = bytes.toString('utf8');
  const replaceRange = (start, end, replacement) => {
    const first = text.indexOf(start);
    const last = text.indexOf(end, first + start.length);
    if (first < 0 || last <= first || text.indexOf(start, first + 1) !== -1)
      throw Error('Unexpected recorded STEP glue layout.');
    text = text.slice(0, first) + replacement + text.slice(last);
  };
  // Remove both dynamic-code helper functions as well as their invoker caller.
  replaceRange('function newFunc(', 'var ensureOverloadTable=', craftInvokerFunction.toString());
  replaceRange(
    'var __emval_get_method_caller=',
    'var __emval_get_property=',
    `var __emval_get_method_caller=${staticMethodCaller.toString()};`,
  );
  // The supported Chromium provides globalThis; omit the Function fallback.
  replaceRange(
    'var emval_get_global=',
    'var __emval_get_global=',
    'var emval_get_global=()=>globalThis;',
  );
  if (/newFunc\(|\bFunction\s*\(|\beval\s*\(/.test(text))
    throw Error('Unexpected dynamic execution in recorded STEP glue.');
  adapted = text;
  return adapted;
}

module.exports = { recordedOcctGlue, OCCT_GLUE_SHA256 };
