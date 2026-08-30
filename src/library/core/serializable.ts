import { ProtocolValidationError } from './errors.js';
import type { DeepReadonly, JsonValue } from './types.js';

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(path: string, message: string): never {
  throw new ProtocolValidationError('NON_SERIALIZABLE_VALUE', `${path} ${message}`);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownEnumerableStringKeys(
  value: object,
  path: string,
  allowArrayLength = false
): string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      return fail(path, 'contains a symbol key.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      return fail(path, `contains the accessor property "${key}".`);
    }
    if (!descriptor.enumerable && !(allowArrayLength && key === 'length')) {
      return fail(path, `contains the non-enumerable property "${key}".`);
    }
    if (descriptor.enumerable) {
      keys.push(key);
    }
  }
  return keys;
}

function cloneJsonInternal(
  value: unknown,
  path: string,
  seen: WeakSet<object>
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return fail(path, 'must be a finite number.');
    }
    return value;
  }

  if (typeof value !== 'object') {
    return fail(path, 'contains a non-JSON value.');
  }

  if (seen.has(value)) {
    return fail(path, 'contains a circular reference.');
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const enumerableKeys = ownEnumerableStringKeys(value, path, true);
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          return fail(path, `contains a sparse slot at index ${index}.`);
        }
      }
      if (enumerableKeys.some((key) => !/^(0|[1-9][0-9]*)$/u.test(key))) {
        return fail(path, 'contains a custom array property.');
      }
      return value.map((item, index) => cloneJsonInternal(item, `${path}[${index}]`, seen));
    }

    if (!isPlainObject(value)) {
      return fail(path, 'must contain plain objects only.');
    }

    const output: Record<string, JsonValue> = {};
    for (const key of ownEnumerableStringKeys(value, path)) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        return fail(path, `contains the forbidden key "${key}".`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      output[key] = cloneJsonInternal(descriptor?.value, `${path}.${key}`, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error('A validated JSON primitive could not be encoded.');
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`)
    .join(',')}}`;
}

export function cloneJson<Value>(value: Value, path = 'value'): Value {
  return cloneJsonInternal(value, path, new WeakSet()) as Value;
}

export function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value as DeepReadonly<Value>;
}

export function cloneAndFreezeJson<Value>(value: Value, path = 'value'): DeepReadonly<Value> {
  return deepFreeze(cloneJson(value, path));
}

export function stableJsonFingerprint(value: unknown): string {
  return canonicalJson(cloneJson(value) as JsonValue);
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(stableJsonFingerprint(value)).byteLength;
}
