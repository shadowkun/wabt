/*
 * Copyright 2016 WebAssembly Community Group participants
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var wabt = wabt || {};

(function (wabt) {

"use strict";

var WABT_OK = 0;
var WABT_ERROR = 1;

/// Allocate memory in the Module.
function malloc(size) {
  var addr = Module._malloc(size);
  if (addr == 0) {
    throw new Error('out of memory');
  }
  return addr;
}

/// Convert an ArrayBuffer/TypedArray/string into a buffer that can be
/// used by the Module.
function allocateBuffer(buf) {
  var addr;
  var size;
  if (buf instanceof ArrayBuffer) {
    size = buf.byteLength;
    addr = malloc(size);
    HEAPU8.set(new Uint8Array(buf), addr);
  } else if (ArrayBuffer.isView(buf)) {
    size = buf.byteLength;
    addr = malloc(size);
    HEAPU8.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
               addr);
  } else if (typeof buf == 'string') {
    size = buf.length;
    addr = malloc(size);
    Module.writeAsciiToMemory(buf, addr, true);  // don't null-terminate
  } else {
    throw new Error('unknown buffer type: ' + buf);
  }
  return {addr: addr, size: size};
}

function allocateCString(s) {
  var size = s.length;
  var addr = malloc(size);
  Module.writeAsciiToMemory(s, addr);
  return {addr: addr, size: size};
}


/// Lexer
function Lexer(filename, buffer) {
  this.filenameObj = allocateCString(filename);
  this.bufferObj = allocateBuffer(buffer);
  this.addr = Module._wabt_new_wast_buffer_lexer(
      this.filenameObj.addr, this.bufferObj.addr, this.bufferObj.size);
}
Lexer.prototype = Object.create(Object.prototype);

Lexer.prototype.destroy = function() {
  Module._wabt_destroy_wast_lexer(this.addr);
  Module._free(this.bufferObj.addr);
  Module._free(this.filenameObj.addr);
};


/// OutputBuffer
function OutputBuffer(addr) {
  this.addr = addr;
}
OutputBuffer.prototype = Object.create(Object.prototype);

OutputBuffer.prototype.toTypedArray = function() {
  if (!this.addr) {
    return null;
  }

  var addr = Module._wabt_output_buffer_get_data(this.addr);
  var size = Module._wabt_output_buffer_get_size(this.addr);
  var buffer = new Uint8Array(size);
  buffer.set(new Uint8Array(HEAPU8.buffer, addr, size));
  return buffer;
};

OutputBuffer.prototype.toString = function() {
  if (!this.addr) {
    return '';
  }

  var addr = Module._wabt_output_buffer_get_data(this.addr);
  var size = Module._wabt_output_buffer_get_size(this.addr);
  return Module.Pointer_stringify(addr, size);
};

OutputBuffer.prototype.destroy = function() {
  Module._wabt_destroy_output_buffer(this.addr);
};


/// SourceErrorHandler
function SourceErrorHandler() {
  this.addr = Module._wabt_new_source_error_handler_buffer();
}
SourceErrorHandler.prototype = Object.create(Object.prototype);

SourceErrorHandler.prototype.getMessage = function() {
  var addr = Module._wabt_source_error_handler_buffer_get_data(this.addr);
  var size = Module._wabt_source_error_handler_buffer_get_size(this.addr);
  return Module.Pointer_stringify(addr, size);
}

SourceErrorHandler.prototype.destroy = function() {
  Module._wabt_destroy_source_error_handler_buffer(this.addr);
};


/// parseWast
function parseWast(filename, buffer) {
  var lexer = new Lexer(filename, buffer);
  var errorHandler = new SourceErrorHandler();

  try {
    var parseResult_addr =
        Module._wabt_parse_wast(lexer.addr, errorHandler.addr);

    var result = Module._wabt_parse_wast_result_get_result(parseResult_addr);
    if (result !== WABT_OK) {
      throw new Error('parseWast failed:\n' + errorHandler.getMessage());
    }

    var script_addr =
        Module._wabt_parse_wast_result_release_script(parseResult_addr);
    var result = new Script(lexer, script_addr);
    // Clear lexer so it isn't destroyed below.
    lexer = null;
    return result;
  } finally {
    Module._wabt_destroy_parse_wast_result(parseResult_addr);
    errorHandler.destroy();
    if (lexer) {
      lexer.destroy();
    }
  }
}


// readWasm
function readWasm(buffer, options) {
  var bufferObj = allocateBuffer(buffer);
  var errorHandler = new BinaryErrorHandler();
  var read_debug_names = options.read_debug_names || true;

  try {
    var readWasmResult_addr =
        Module._wabt_read_binary(buffer.addr, buffer.size, read_debug_names);

    var result =
        Module._wabt_read_binary_result_get_result(readWasmResult_addr);
    if (result !== WABT_OK) {
      throw new Error('readWasm failed:\n' + errorHandler.getMessage());
    }

    var module_addr =
        Module._wabt_read_binary_result_release_module(readWasmResult_addr);
    var result = new Module(module_addr);
    return result;
  } finally {
    Module._wabt_destroy_read_binary_result(readWasmResult_addr);
    errorHandler.destroy();
    Module._free(bufferObj.addr);
  }
}


/// Script
function Script(lexer, script_addr) {
  this.lexer = lexer;
  this.script_addr = script_addr;
}
Script.prototype = Object.create(Object.prototype);

Script.prototype.resolveNames = function() {
  var errorHandler = new SourceErrorHandler();
  try {
    var result = Module._wabt_resolve_names_script(
        this.lexer.addr, this.script_addr, errorHandler.addr);
    if (result !== WABT_OK) {
      throw new Error('resolveNames failed:\n' + errorHandler.getMessage());
    }
  } finally {
    errorHandler.destroy();
  }
};

Script.prototype.validate = function() {
  var errorHandler = new SourceErrorHandler();
  try {
    var result = Module._wabt_validate_script(this.lexer.addr, this.script_addr,
                                              errorHandler.addr);
    if (result !== WABT_OK) {
      throw new Error('validate failed:\n' + errorHandler.getMessage());
    }
  } finally {
    errorHandler.destroy();
  }
};

Script.prototype.toBinary = function(options) {
  var module_addr = Module._wabt_get_first_module(this.script_addr);
  var module = new Module(module_addr);
  return module.toBinary(options);
};

Script.prototype.destroy = function() {
  Module._wabt_destroy_script(this.script_addr);
  this.lexer.destroy();
};


// Module
function Module(module_addr) {
  this.module_addr = module_addr;
}
Module.prototype = Object.create(Object.prototype);

Module.prototype.generateNames = function() {
  var result = Module._wabt_generate_names_module(this.module_addr);
  if (result !== WABT_OK) {
    throw new Error('generateNames failed.');
  }
};

Module.prototype.toWat = function(options) {
  var fold_exprs = options.fold_exprs || false;
  var inline_export = options.inline_export || false;

  var writeModuleResult_addr = Module._wabt_write_text_module(
      this.module_addr, fold_exprs, inline_export);

  var result =
      Module._wabt_write_module_result_get_result(writeModuleResult_addr);

  try {
    if (result !== WABT_OK) {
      throw new Error('toWat failed.');
    }

    var outputBuffer = new OutputBuffer(
        Module._wabt_write_module_result_release_binary_output_buffer(
            writeModuleResult_addr));

    return outputBuffer.toTypedArray();

  } finally {
    if (outptuBuffer) {
      outptuBuffer.destroy();
    }
    Module._wabt_destroy_write_module_result(writeModuleResult_addr);
  }
};

Module.prototype.toBinary = function(options) {
  var log = options.log || false;
  var canonicalize_lebs = options.canonicalize_lebs || true;
  var relocatable = options.relocatable || false;
  var write_debug_names = options.write_debug_names || false;

  var writeModuleResult_addr = Module._wabt_write_binary_module(
      this.module_addr, log, canonicalize_lebs, relocatable, write_debug_names);

  var result =
      Module._wabt_write_module_result_get_result(writeModuleResult_addr);

  try {
    if (result !== WABT_OK) {
      throw new Error('toBinary failed.');
    }

    var binaryOutputBuffer = new OutputBuffer(
        Module._wabt_write_module_result_release_binary_output_buffer(
            writeModuleResult_addr));
    var logOutputBuffer = new OutputBuffer(
        Module._wabt_write_module_result_release_log_output_buffer(
            writeModuleResult_addr));

    return {
      buffer: binaryOutputBuffer.toTypedArray(),
      log: logOutputBuffer.toString()
    };

  } finally {
    if (binaryOutputBuffer) {
      binaryOutputBuffer.destroy();
    }
    if (logOutputBuffer) {
      logOutputBuffer.destroy();
    }
    Module._wabt_destroy_write_module_result(writeModuleResult_addr);
  }
};

Module.prototype.destroy = function() {
  Module._wabt_destroy_module(this.module_addr);
};

wabt.ready = Promise.resolve();
wabt.parseWast = parseWast;
wabt.readWasm = readWasm;

})(wabt);
