'use strict';

// The TypeError family of syncom's errors (src/errors.js has the rest and re-exports these): a wrong argument,
// option, definition or hook result — an ArgumentError, or an ArgumentRangeError where the API always threw a
// RangeError — and a value of data or configuration refused, a DataError with its code and details. No requires:
// a module that throws nothing else requires this file alone, so a small subpath stays small.

const INVALID_ARGUMENT = 'ALX_ERR_INVALID_ARGUMENT';

class ArgumentError extends TypeError {
  constructor(message, options) {
    super(message, options);
    this.name = 'ArgumentError';
    this.code = INVALID_ARGUMENT;
  }
}

class ArgumentRangeError extends RangeError {
  constructor(message, options) {
    super(message, options);
    this.name = 'ArgumentRangeError';
    this.code = INVALID_ARGUMENT;
  }
}

// One shape for every code: `details` is null where the code documents nothing (`{ entity, field }` of an id a
// collection refused, `{ length, max }` of a blob past the cap).
class DataError extends TypeError {
  constructor(code, message, details = null, options = undefined) {
    super(message, options);
    this.name = 'DataError';
    this.code = code;
    this.details = details;
  }
}

module.exports = { INVALID_ARGUMENT, ArgumentError, ArgumentRangeError, DataError };
