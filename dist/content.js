(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // node_modules/js-binary-schema-parser/lib/index.js
  var require_lib = __commonJS({
    "node_modules/js-binary-schema-parser/lib/index.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.loop = exports.conditional = exports.parse = void 0;
      var parse = function parse2(stream, schema) {
        var result = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {};
        var parent = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : result;
        if (Array.isArray(schema)) {
          schema.forEach(function(partSchema) {
            return parse2(stream, partSchema, result, parent);
          });
        } else if (typeof schema === "function") {
          schema(stream, result, parent, parse2);
        } else {
          var key = Object.keys(schema)[0];
          if (Array.isArray(schema[key])) {
            parent[key] = {};
            parse2(stream, schema[key], result, parent[key]);
          } else {
            parent[key] = schema[key](stream, result, parent, parse2);
          }
        }
        return result;
      };
      exports.parse = parse;
      var conditional = function conditional2(schema, conditionFunc) {
        return function(stream, result, parent, parse2) {
          if (conditionFunc(stream, result, parent)) {
            parse2(stream, schema, result, parent);
          }
        };
      };
      exports.conditional = conditional;
      var loop = function loop2(schema, continueFunc) {
        return function(stream, result, parent, parse2) {
          var arr = [];
          var lastStreamPos = stream.pos;
          while (continueFunc(stream, result, parent)) {
            var newParent = {};
            parse2(stream, schema, result, newParent);
            if (stream.pos === lastStreamPos) {
              break;
            }
            lastStreamPos = stream.pos;
            arr.push(newParent);
          }
          return arr;
        };
      };
      exports.loop = loop;
    }
  });

  // node_modules/js-binary-schema-parser/lib/parsers/uint8.js
  var require_uint8 = __commonJS({
    "node_modules/js-binary-schema-parser/lib/parsers/uint8.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.readBits = exports.readArray = exports.readUnsigned = exports.readString = exports.peekBytes = exports.readBytes = exports.peekByte = exports.readByte = exports.buildStream = void 0;
      var buildStream = function buildStream2(uint8Data) {
        return {
          data: uint8Data,
          pos: 0
        };
      };
      exports.buildStream = buildStream;
      var readByte = function readByte2() {
        return function(stream) {
          return stream.data[stream.pos++];
        };
      };
      exports.readByte = readByte;
      var peekByte = function peekByte2() {
        var offset = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : 0;
        return function(stream) {
          return stream.data[stream.pos + offset];
        };
      };
      exports.peekByte = peekByte;
      var readBytes = function readBytes2(length) {
        return function(stream) {
          return stream.data.subarray(stream.pos, stream.pos += length);
        };
      };
      exports.readBytes = readBytes;
      var peekBytes = function peekBytes2(length) {
        return function(stream) {
          return stream.data.subarray(stream.pos, stream.pos + length);
        };
      };
      exports.peekBytes = peekBytes;
      var readString = function readString2(length) {
        return function(stream) {
          return Array.from(readBytes(length)(stream)).map(function(value) {
            return String.fromCharCode(value);
          }).join("");
        };
      };
      exports.readString = readString;
      var readUnsigned = function readUnsigned2(littleEndian) {
        return function(stream) {
          var bytes = readBytes(2)(stream);
          return littleEndian ? (bytes[1] << 8) + bytes[0] : (bytes[0] << 8) + bytes[1];
        };
      };
      exports.readUnsigned = readUnsigned;
      var readArray = function readArray2(byteSize, totalOrFunc) {
        return function(stream, result, parent) {
          var total = typeof totalOrFunc === "function" ? totalOrFunc(stream, result, parent) : totalOrFunc;
          var parser = readBytes(byteSize);
          var arr = new Array(total);
          for (var i = 0; i < total; i++) {
            arr[i] = parser(stream);
          }
          return arr;
        };
      };
      exports.readArray = readArray;
      var subBitsTotal = function subBitsTotal2(bits, startIndex, length) {
        var result = 0;
        for (var i = 0; i < length; i++) {
          result += bits[startIndex + i] && Math.pow(2, length - i - 1);
        }
        return result;
      };
      var readBits = function readBits2(schema) {
        return function(stream) {
          var _byte = readByte()(stream);
          var bits = new Array(8);
          for (var i = 0; i < 8; i++) {
            bits[7 - i] = !!(_byte & 1 << i);
          }
          return Object.keys(schema).reduce(function(res, key) {
            var def = schema[key];
            if (def.length) {
              res[key] = subBitsTotal(bits, def.index, def.length);
            } else {
              res[key] = bits[def.index];
            }
            return res;
          }, {});
        };
      };
      exports.readBits = readBits;
    }
  });

  // node_modules/js-binary-schema-parser/lib/schemas/gif.js
  var require_gif = __commonJS({
    "node_modules/js-binary-schema-parser/lib/schemas/gif.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports["default"] = void 0;
      var _ = require_lib();
      var _uint = require_uint8();
      var subBlocksSchema = {
        blocks: function blocks(stream) {
          var terminator = 0;
          var chunks = [];
          var streamSize = stream.data.length;
          var total = 0;
          for (var size = (0, _uint.readByte)()(stream); size !== terminator; size = (0, _uint.readByte)()(stream)) {
            if (!size) break;
            if (stream.pos + size >= streamSize) {
              var availableSize = streamSize - stream.pos;
              chunks.push((0, _uint.readBytes)(availableSize)(stream));
              total += availableSize;
              break;
            }
            chunks.push((0, _uint.readBytes)(size)(stream));
            total += size;
          }
          var result = new Uint8Array(total);
          var offset = 0;
          for (var i = 0; i < chunks.length; i++) {
            result.set(chunks[i], offset);
            offset += chunks[i].length;
          }
          return result;
        }
      };
      var gceSchema = (0, _.conditional)({
        gce: [{
          codes: (0, _uint.readBytes)(2)
        }, {
          byteSize: (0, _uint.readByte)()
        }, {
          extras: (0, _uint.readBits)({
            future: {
              index: 0,
              length: 3
            },
            disposal: {
              index: 3,
              length: 3
            },
            userInput: {
              index: 6
            },
            transparentColorGiven: {
              index: 7
            }
          })
        }, {
          delay: (0, _uint.readUnsigned)(true)
        }, {
          transparentColorIndex: (0, _uint.readByte)()
        }, {
          terminator: (0, _uint.readByte)()
        }]
      }, function(stream) {
        var codes = (0, _uint.peekBytes)(2)(stream);
        return codes[0] === 33 && codes[1] === 249;
      });
      var imageSchema = (0, _.conditional)({
        image: [{
          code: (0, _uint.readByte)()
        }, {
          descriptor: [{
            left: (0, _uint.readUnsigned)(true)
          }, {
            top: (0, _uint.readUnsigned)(true)
          }, {
            width: (0, _uint.readUnsigned)(true)
          }, {
            height: (0, _uint.readUnsigned)(true)
          }, {
            lct: (0, _uint.readBits)({
              exists: {
                index: 0
              },
              interlaced: {
                index: 1
              },
              sort: {
                index: 2
              },
              future: {
                index: 3,
                length: 2
              },
              size: {
                index: 5,
                length: 3
              }
            })
          }]
        }, (0, _.conditional)({
          lct: (0, _uint.readArray)(3, function(stream, result, parent) {
            return Math.pow(2, parent.descriptor.lct.size + 1);
          })
        }, function(stream, result, parent) {
          return parent.descriptor.lct.exists;
        }), {
          data: [{
            minCodeSize: (0, _uint.readByte)()
          }, subBlocksSchema]
        }]
      }, function(stream) {
        return (0, _uint.peekByte)()(stream) === 44;
      });
      var textSchema = (0, _.conditional)({
        text: [{
          codes: (0, _uint.readBytes)(2)
        }, {
          blockSize: (0, _uint.readByte)()
        }, {
          preData: function preData(stream, result, parent) {
            return (0, _uint.readBytes)(parent.text.blockSize)(stream);
          }
        }, subBlocksSchema]
      }, function(stream) {
        var codes = (0, _uint.peekBytes)(2)(stream);
        return codes[0] === 33 && codes[1] === 1;
      });
      var applicationSchema = (0, _.conditional)({
        application: [{
          codes: (0, _uint.readBytes)(2)
        }, {
          blockSize: (0, _uint.readByte)()
        }, {
          id: function id(stream, result, parent) {
            return (0, _uint.readString)(parent.blockSize)(stream);
          }
        }, subBlocksSchema]
      }, function(stream) {
        var codes = (0, _uint.peekBytes)(2)(stream);
        return codes[0] === 33 && codes[1] === 255;
      });
      var commentSchema = (0, _.conditional)({
        comment: [{
          codes: (0, _uint.readBytes)(2)
        }, subBlocksSchema]
      }, function(stream) {
        var codes = (0, _uint.peekBytes)(2)(stream);
        return codes[0] === 33 && codes[1] === 254;
      });
      var schema = [
        {
          header: [{
            signature: (0, _uint.readString)(3)
          }, {
            version: (0, _uint.readString)(3)
          }]
        },
        {
          lsd: [{
            width: (0, _uint.readUnsigned)(true)
          }, {
            height: (0, _uint.readUnsigned)(true)
          }, {
            gct: (0, _uint.readBits)({
              exists: {
                index: 0
              },
              resolution: {
                index: 1,
                length: 3
              },
              sort: {
                index: 4
              },
              size: {
                index: 5,
                length: 3
              }
            })
          }, {
            backgroundColorIndex: (0, _uint.readByte)()
          }, {
            pixelAspectRatio: (0, _uint.readByte)()
          }]
        },
        (0, _.conditional)({
          gct: (0, _uint.readArray)(3, function(stream, result) {
            return Math.pow(2, result.lsd.gct.size + 1);
          })
        }, function(stream, result) {
          return result.lsd.gct.exists;
        }),
        // content frames
        {
          frames: (0, _.loop)([gceSchema, applicationSchema, commentSchema, imageSchema, textSchema], function(stream) {
            var nextCode = (0, _uint.peekByte)()(stream);
            return nextCode === 33 || nextCode === 44;
          })
        }
      ];
      var _default = schema;
      exports["default"] = _default;
    }
  });

  // node_modules/gifuct-js/lib/deinterlace.js
  var require_deinterlace = __commonJS({
    "node_modules/gifuct-js/lib/deinterlace.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.deinterlace = void 0;
      var deinterlace = function deinterlace2(pixels, width) {
        var newPixels = new Array(pixels.length);
        var rows = pixels.length / width;
        var cpRow = function cpRow2(toRow2, fromRow2) {
          var fromPixels = pixels.slice(fromRow2 * width, (fromRow2 + 1) * width);
          newPixels.splice.apply(newPixels, [toRow2 * width, width].concat(fromPixels));
        };
        var offsets = [0, 4, 2, 1];
        var steps = [8, 8, 4, 2];
        var fromRow = 0;
        for (var pass = 0; pass < 4; pass++) {
          for (var toRow = offsets[pass]; toRow < rows; toRow += steps[pass]) {
            cpRow(toRow, fromRow);
            fromRow++;
          }
        }
        return newPixels;
      };
      exports.deinterlace = deinterlace;
    }
  });

  // node_modules/gifuct-js/lib/lzw.js
  var require_lzw = __commonJS({
    "node_modules/gifuct-js/lib/lzw.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.lzw = void 0;
      var lzw = function lzw2(minCodeSize, data, pixelCount) {
        var MAX_STACK_SIZE = 4096;
        var nullCode = -1;
        var npix = pixelCount;
        var available, clear, code_mask, code_size, end_of_information, in_code, old_code, bits, code, i, datum, data_size, first, top, bi, pi;
        var dstPixels = new Array(pixelCount);
        var prefix = new Array(MAX_STACK_SIZE);
        var suffix = new Array(MAX_STACK_SIZE);
        var pixelStack = new Array(MAX_STACK_SIZE + 1);
        data_size = minCodeSize;
        clear = 1 << data_size;
        end_of_information = clear + 1;
        available = clear + 2;
        old_code = nullCode;
        code_size = data_size + 1;
        code_mask = (1 << code_size) - 1;
        for (code = 0; code < clear; code++) {
          prefix[code] = 0;
          suffix[code] = code;
        }
        var datum, bits, count, first, top, pi, bi;
        datum = bits = count = first = top = pi = bi = 0;
        for (i = 0; i < npix; ) {
          if (top === 0) {
            if (bits < code_size) {
              datum += data[bi] << bits;
              bits += 8;
              bi++;
              continue;
            }
            code = datum & code_mask;
            datum >>= code_size;
            bits -= code_size;
            if (code > available || code == end_of_information) {
              break;
            }
            if (code == clear) {
              code_size = data_size + 1;
              code_mask = (1 << code_size) - 1;
              available = clear + 2;
              old_code = nullCode;
              continue;
            }
            if (old_code == nullCode) {
              pixelStack[top++] = suffix[code];
              old_code = code;
              first = code;
              continue;
            }
            in_code = code;
            if (code == available) {
              pixelStack[top++] = first;
              code = old_code;
            }
            while (code > clear) {
              pixelStack[top++] = suffix[code];
              code = prefix[code];
            }
            first = suffix[code] & 255;
            pixelStack[top++] = first;
            if (available < MAX_STACK_SIZE) {
              prefix[available] = old_code;
              suffix[available] = first;
              available++;
              if ((available & code_mask) === 0 && available < MAX_STACK_SIZE) {
                code_size++;
                code_mask += available;
              }
            }
            old_code = in_code;
          }
          top--;
          dstPixels[pi++] = pixelStack[top];
          i++;
        }
        for (i = pi; i < npix; i++) {
          dstPixels[i] = 0;
        }
        return dstPixels;
      };
      exports.lzw = lzw;
    }
  });

  // node_modules/gifuct-js/lib/index.js
  var require_lib2 = __commonJS({
    "node_modules/gifuct-js/lib/index.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.decompressFrames = exports.decompressFrame = exports.parseGIF = void 0;
      var _gif = _interopRequireDefault(require_gif());
      var _jsBinarySchemaParser = require_lib();
      var _uint = require_uint8();
      var _deinterlace = require_deinterlace();
      var _lzw = require_lzw();
      function _interopRequireDefault(obj) {
        return obj && obj.__esModule ? obj : { "default": obj };
      }
      var parseGIF2 = function parseGIF3(arrayBuffer) {
        var byteData = new Uint8Array(arrayBuffer);
        return (0, _jsBinarySchemaParser.parse)((0, _uint.buildStream)(byteData), _gif["default"]);
      };
      exports.parseGIF = parseGIF2;
      var generatePatch = function generatePatch2(image) {
        var totalPixels = image.pixels.length;
        var patchData = new Uint8ClampedArray(totalPixels * 4);
        for (var i = 0; i < totalPixels; i++) {
          var pos = i * 4;
          var colorIndex = image.pixels[i];
          var color = image.colorTable[colorIndex] || [0, 0, 0];
          patchData[pos] = color[0];
          patchData[pos + 1] = color[1];
          patchData[pos + 2] = color[2];
          patchData[pos + 3] = colorIndex !== image.transparentIndex ? 255 : 0;
        }
        return patchData;
      };
      var decompressFrame = function decompressFrame2(frame, gct, buildImagePatch) {
        if (!frame.image) {
          console.warn("gif frame does not have associated image.");
          return;
        }
        var image = frame.image;
        var totalPixels = image.descriptor.width * image.descriptor.height;
        var pixels = (0, _lzw.lzw)(image.data.minCodeSize, image.data.blocks, totalPixels);
        if (image.descriptor.lct.interlaced) {
          pixels = (0, _deinterlace.deinterlace)(pixels, image.descriptor.width);
        }
        var resultImage = {
          pixels,
          dims: {
            top: frame.image.descriptor.top,
            left: frame.image.descriptor.left,
            width: frame.image.descriptor.width,
            height: frame.image.descriptor.height
          }
        };
        if (image.descriptor.lct && image.descriptor.lct.exists) {
          resultImage.colorTable = image.lct;
        } else {
          resultImage.colorTable = gct;
        }
        if (frame.gce) {
          resultImage.delay = (frame.gce.delay || 10) * 10;
          resultImage.disposalType = frame.gce.extras.disposal;
          if (frame.gce.extras.transparentColorGiven) {
            resultImage.transparentIndex = frame.gce.transparentColorIndex;
          }
        }
        if (buildImagePatch) {
          resultImage.patch = generatePatch(resultImage);
        }
        return resultImage;
      };
      exports.decompressFrame = decompressFrame;
      var decompressFrames2 = function decompressFrames3(parsedGif, buildImagePatches) {
        return parsedGif.frames.filter(function(f) {
          return f.image;
        }).map(function(f) {
          return decompressFrame(f, parsedGif.gct, buildImagePatches);
        });
      };
      exports.decompressFrames = decompressFrames2;
    }
  });

  // src/content.js
  var import_gifuct_js = __toESM(require_lib2(), 1);
  console.log("[GIF] ========== CONTENT SCRIPT LOADED ==========");
  var PAGE_LOAD_TIME = performance.now();
  var processed = /* @__PURE__ */ new Set();
  var pending = /* @__PURE__ */ new Map();
  var firstCaptionTime = null;
  var allCaptionsTime = null;
  var totalGifsFound = 0;
  var totalCaptioned = 0;
  var initialScanDone = false;
  var modelReadyTime = null;
  var modelDevice = "unknown";
  var gifsFoundTime = null;
  var MAX_GIFS = 10;
  var NUM_FRAMES = 16;
  var GRID_ROWS = 4;
  var GRID_COLS = 4;
  var CELL_SIZE = 128;
  var FINAL_SIZE = 512;
  var PAD_BETWEEN_FRAMES = 4;
  var PAD_COLOR = "#000000";
  function logTiming(event) {
    const elapsed = Math.round(performance.now() - PAGE_LOAD_TIME);
    console.log("[GIF] [" + elapsed + "ms] " + event);
  }
  function isContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }
  async function getModelStatus() {
    if (!isContextValid()) return null;
    try {
      const data = await chrome.storage.local.get("modelStatus");
      return data.modelStatus || null;
    } catch {
      return null;
    }
  }
  function isInViewport(img) {
    const rect = img.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0;
  }
  function printSummary() {
    if (allCaptionsTime) return;
    allCaptionsTime = performance.now() - PAGE_LOAD_TIME;
    const captioningTime = gifsFoundTime ? allCaptionsTime - gifsFoundTime : allCaptionsTime;
    console.log("[GIF] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
    console.log("[GIF] \u{1F389} ACCESSIBILITY READY");
    console.log("[GIF]   Page load \u2192 ready: " + (allCaptionsTime / 1e3).toFixed(1) + "s");
    console.log("[GIF]   Model load: " + ((modelReadyTime || 0) / 1e3).toFixed(1) + "s");
    console.log("[GIF]   First caption: " + ((firstCaptionTime || 0) / 1e3).toFixed(1) + "s");
    console.log("[GIF]   Captioning: " + (captioningTime / 1e3).toFixed(1) + "s");
    console.log("[GIF]   GIFs: " + totalCaptioned + " (" + modelDevice + ")");
    if (totalCaptioned > 0) {
      console.log("[GIF]   Avg: " + Math.round(captioningTime / totalCaptioned) + "ms/GIF");
    }
    console.log("[GIF] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  }
  function applyCaption(img, caption, time) {
    img.alt = caption;
    img.setAttribute("aria-label", caption);
    img.setAttribute("role", "img");
    img.setAttribute("tabindex", "0");
    totalCaptioned++;
    if (!firstCaptionTime) {
      firstCaptionTime = performance.now() - PAGE_LOAD_TIME;
    }
    logTiming("\u2713 [" + totalCaptioned + "/" + totalGifsFound + "] URL=" + img.src + ' CAPTION="' + caption + '" (' + time + "ms)");
    if (totalCaptioned >= totalGifsFound && totalGifsFound > 0) {
      printSummary();
    }
  }
  async function extractGifFrames(gifUrl) {
    const response = await fetch(gifUrl, { mode: "cors" });
    if (!response.ok) throw new Error("Fetch failed");
    const buffer = await response.arrayBuffer();
    const gif = (0, import_gifuct_js.parseGIF)(buffer);
    const frames = (0, import_gifuct_js.decompressFrames)(gif, true);
    if (!frames || frames.length === 0) {
      throw new Error("No frames");
    }
    return frames;
  }
  function renderFrame(frame, canvas, ctx) {
    const { width, height } = frame.dims;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const imageData = new ImageData(
      new Uint8ClampedArray(frame.patch),
      frame.dims.width,
      frame.dims.height
    );
    ctx.putImageData(imageData, frame.dims.left || 0, frame.dims.top || 0);
  }
  function letterboxToCell(destCtx, srcCanvas, cellX, cellY, cellSize) {
    const scale = Math.min(cellSize / srcCanvas.width, cellSize / srcCanvas.height);
    const w = srcCanvas.width * scale;
    const h = srcCanvas.height * scale;
    const x = cellX + (cellSize - w) / 2;
    const y = cellY + (cellSize - h) / 2;
    destCtx.drawImage(srcCanvas, x, y, w, h);
  }
  function createGrid(frames) {
    const gridW = GRID_COLS * CELL_SIZE + (GRID_COLS - 1) * PAD_BETWEEN_FRAMES;
    const gridH = GRID_ROWS * CELL_SIZE + (GRID_ROWS - 1) * PAD_BETWEEN_FRAMES;
    const canvas = document.createElement("canvas");
    canvas.width = FINAL_SIZE;
    canvas.height = FINAL_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = PAD_COLOR;
    ctx.fillRect(0, 0, FINAL_SIZE, FINAL_SIZE);
    const gridCanvas = document.createElement("canvas");
    gridCanvas.width = gridW;
    gridCanvas.height = gridH;
    const gridCtx = gridCanvas.getContext("2d");
    gridCtx.fillStyle = PAD_COLOR;
    gridCtx.fillRect(0, 0, gridW, gridH);
    const frameCanvas = document.createElement("canvas");
    const frameCtx = frameCanvas.getContext("2d");
    const indices = [];
    const step = Math.max(1, (frames.length - 1) / (NUM_FRAMES - 1));
    for (let i = 0; i < NUM_FRAMES; i++) {
      indices.push(Math.min(Math.floor(i * step), frames.length - 1));
    }
    for (let i = 0; i < NUM_FRAMES; i++) {
      const frame = frames[indices[i]];
      const row = Math.floor(i / GRID_COLS);
      const col = i % GRID_COLS;
      const x = col * (CELL_SIZE + PAD_BETWEEN_FRAMES);
      const y = row * (CELL_SIZE + PAD_BETWEEN_FRAMES);
      renderFrame(frame, frameCanvas, frameCtx);
      letterboxToCell(gridCtx, frameCanvas, x, y, CELL_SIZE);
    }
    const scale = Math.min(FINAL_SIZE / gridW, FINAL_SIZE / gridH);
    const finalW = gridW * scale;
    const finalH = gridH * scale;
    const offsetX = (FINAL_SIZE - finalW) / 2;
    const offsetY = (FINAL_SIZE - finalH) / 2;
    ctx.drawImage(gridCanvas, offsetX, offsetY, finalW, finalH);
    return canvas.toDataURL("image/jpeg", 0.85);
  }
  function compositeFrames(frames, toIndex) {
    const gifWidth = frames[0].dims.width;
    const gifHeight = frames[0].dims.height;
    const canvas = document.createElement("canvas");
    canvas.width = gifWidth;
    canvas.height = gifHeight;
    const ctx = canvas.getContext("2d");
    for (let i = 0; i <= toIndex; i++) {
      const f = frames[i];
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(f.patch), f.dims.width, f.dims.height),
        f.dims.left || 0,
        f.dims.top || 0
      );
    }
    return canvas.toDataURL("image/png");
  }
  async function getImageData(img) {
    try {
      const frames = await extractGifFrames(img.src);
      const grid = createGrid(frames);
      const mid = Math.max(0, Math.floor(frames.length / 2) - 1);
      const ocrFrames = [
        compositeFrames(frames, 0),
        compositeFrames(frames, mid)
      ];
      return { grid, ocrFrames };
    } catch (e) {
      const fallback = await getFallbackImageData(img);
      return { grid: fallback, ocrFrames: [fallback] };
    }
  }
  async function getFallbackImageData(img) {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = FINAL_SIZE;
      const ctx = canvas.getContext("2d");
      const corsImg = new Image();
      corsImg.crossOrigin = "anonymous";
      corsImg.onload = () => {
        try {
          ctx.fillStyle = PAD_COLOR;
          ctx.fillRect(0, 0, FINAL_SIZE, FINAL_SIZE);
          const scale = Math.min(FINAL_SIZE / corsImg.naturalWidth, FINAL_SIZE / corsImg.naturalHeight);
          const w = corsImg.naturalWidth * scale;
          const h = corsImg.naturalHeight * scale;
          ctx.drawImage(corsImg, (FINAL_SIZE - w) / 2, (FINAL_SIZE - h) / 2, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        } catch (e) {
          reject(e);
        }
      };
      corsImg.onerror = () => reject(new Error("CORS"));
      corsImg.src = img.src;
    });
  }
  async function queueGif(img, priority) {
    if (!isContextValid()) {
      logTiming("queueGif: context invalid, skipping");
      return;
    }
    if (processed.has(img.src)) {
      logTiming("queueGif: already processed, skipping");
      return;
    }
    processed.add(img.src);
    const id = "g" + Date.now() + Math.random().toString(36).slice(2, 6);
    pending.set(id, img);
    try {
      logTiming("queueGif: extracting frames for " + id);
      const { grid, ocrFrames } = await getImageData(img);
      logTiming("queueGif: frames extracted, grid size=" + grid.length + " ocrFrames=" + ocrFrames.length);
      const storageData = await chrome.storage.local.get("captionQueue");
      const queue = storageData.captionQueue || [];
      if (priority) {
        queue.unshift({ gifId: id, imageData: grid, ocrFrames });
      } else {
        queue.push({ gifId: id, imageData: grid, ocrFrames });
      }
      await chrome.storage.local.set({ captionQueue: queue });
      logTiming("queueGif: " + id + " added to queue (length=" + queue.length + ")");
    } catch (e) {
      logTiming("queueGif ERROR: " + e.message);
      processed.delete(img.src);
      pending.delete(id);
    }
  }
  async function checkResults() {
    if (!isContextValid()) return;
    try {
      const data = await chrome.storage.local.get("captionResults");
      const results = data.captionResults || {};
      for (const id of Object.keys(results)) {
        const r = results[id];
        const img = pending.get(id);
        if (img && r?.caption) {
          applyCaption(img, r.caption, r.time);
          pending.delete(id);
          delete results[id];
          await chrome.storage.local.set({ captionResults: results });
        }
      }
    } catch (e) {
    }
  }
  var isScanning = false;
  async function scan() {
    if (initialScanDone || isScanning) return;
    isScanning = true;
    try {
      const status = await getModelStatus();
      if (!status || status.status !== "ready") return;
      if (!modelReadyTime) {
        modelReadyTime = performance.now() - PAGE_LOAD_TIME;
        modelDevice = status.device || "unknown";
        logTiming("Model ready! (" + modelDevice + ")");
      }
      const allImages = document.querySelectorAll("img");
      const visibleGifs = [];
      const hiddenGifs = [];
      allImages.forEach((img) => {
        const src = img.src.toLowerCase();
        const isGif = src.includes(".gif") || img.src.includes(".gif");
        if (isGif && !processed.has(img.src) && img.naturalWidth > 100) {
          if (isInViewport(img)) {
            visibleGifs.push(img);
          } else {
            hiddenGifs.push(img);
          }
        }
      });
      const allGifs = [...visibleGifs, ...hiddenGifs].slice(0, MAX_GIFS);
      const visibleCount = Math.min(visibleGifs.length, MAX_GIFS);
      if (allGifs.length === 0) return;
      totalGifsFound = allGifs.length;
      initialScanDone = true;
      gifsFoundTime = performance.now() - PAGE_LOAD_TIME;
      logTiming("Found " + totalGifsFound + " GIFs (" + visibleCount + " visible)");
      for (let i = 0; i < allGifs.length; i++) {
        await queueGif(allGifs[i], i < visibleCount);
      }
      logTiming("All " + totalGifsFound + " GIFs queued");
    } finally {
      isScanning = false;
    }
  }
  if (isContextValid()) {
    logTiming("Initializing...");
    (async () => {
      const pageModelId = window.localStorage?.getItem("gif_model_id");
      if (pageModelId) {
        const stored = await chrome.storage.local.get("selectedModelId");
        if (stored.selectedModelId !== pageModelId) {
          await chrome.storage.local.set({
            selectedModelId: pageModelId,
            captionQueue: [],
            captionResults: {}
          });
          logTiming("Model switched to: " + pageModelId);
        }
      }
    })();
    setInterval(checkResults, 200);
    const scanInterval = setInterval(() => {
      if (initialScanDone) {
        clearInterval(scanInterval);
        return;
      }
      scan();
    }, 1e3);
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.modelStatus?.newValue?.status === "ready" && !initialScanDone) {
        scan();
      }
    });
    let scanDebounce = null;
    const observer = new MutationObserver((mutations) => {
      if (initialScanDone) return;
      let hasNewImages = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeName === "IMG" || node.querySelectorAll && node.querySelectorAll("img").length > 0) {
            hasNewImages = true;
            break;
          }
        }
        if (hasNewImages) break;
      }
      if (hasNewImages) {
        clearTimeout(scanDebounce);
        scanDebounce = setTimeout(() => {
          logTiming("MutationObserver: new images detected, scanning...");
          scan();
        }, 500);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
  } else {
    console.error("[GIF] Extension context invalid!");
  }
})();
