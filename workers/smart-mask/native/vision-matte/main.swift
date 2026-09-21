// fp-vision-matte: the Smart Mask pack's Fast engine on macOS (plan 13, SP3).
//
// WHY A NATIVE HELPER: the pack's models (SAM 2.1 Large, BiRefNet) cost 17-40 s per 1080p frame
// on the CPU and still ~2-3 s on an M1 Pro's GPU, so a one-minute clip takes hours. Apple's
// Vision framework segments the same frame in ~50-200 ms on the Neural Engine, ships with the
// OS (no weights, no licence question) and returns a soft matte. Vision has no Python binding
// the pack may ship, so the Python worker drives this process over stdin/stdout.
//
// PROTOCOL (little-endian, one request -> one response, until EOF on stdin):
//   launch:   fp-vision-matte --width W --height H
//   request:  "FPVM" | mode u32 | flags u32 | box 4 x f32 (x0 y0 x1 y1, normalised, top-left
//             origin) | W*H*3 bytes RGB
//             mode 0 = the main subject: seeded by the largest foreground instance, then
//                      followed frame to frame by overlap (taking EVERY instance made a lamp
//                      behind a presenter flicker in and out); falls back to the person matte
//                      when Vision finds no instance
//             mode 1 = the instances the box seeds, then followed the same way
//             flags bit 0 = forget the followed selection (a new window or a new seed)
//             flags bit 1 = also answer with the person matte, which the worker uses to drop
//                           background objects Vision fused into the subject's instance
//   response: status u32 (0 ok, 1 nothing found: alpha is all zero) | instances u32 |
//             W*H bytes alpha [| W*H bytes person matte, when flags bit 1 was set]
// Nothing else is ever written to stdout; diagnostics go to stderr.

import Accelerate
import CoreImage
import CoreVideo
import Foundation
import Vision

let MAGIC: [UInt8] = Array("FPVM".utf8)
/// An instance belongs to the followed subject when this share of it lay inside the previous selection.
let FOLLOW_OVERLAP: Float = 0.5
/// A lost main subject is re-seeded only by an instance at least this share of its last size, so
/// background clutter does not become the subject when the presenter steps out of frame.
let RESEED_AREA_SHARE: Float = 0.25

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(2)
}

func argument(_ name: String) -> Int {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count, let value = Int(args[index + 1]),
    value > 0, value <= 8192
  else { fail("usage: fp-vision-matte --width W --height H") }
  return value
}

let width = argument("--width")
let height = argument("--height")
let input = FileHandle.standardInput
let output = FileHandle.standardOutput

func readExactly(_ count: Int) -> Data? {
  var data = Data(capacity: count)
  while data.count < count {
    let chunk = input.readData(ofLength: count - data.count)
    if chunk.isEmpty {
      if data.isEmpty { return nil }
      fail("stdin closed in the middle of a request")
    }
    data.append(chunk)
  }
  return data
}

func makeBuffer(_ format: OSType) -> CVPixelBuffer {
  var buffer: CVPixelBuffer?
  let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
  guard CVPixelBufferCreate(nil, width, height, format, attributes, &buffer) == kCVReturnSuccess, let made = buffer
  else { fail("could not allocate a \(width)x\(height) pixel buffer") }
  return made
}

let frame = makeBuffer(kCVPixelFormatType_32BGRA)

/// RGB bytes -> the BGRA pixel buffer Vision reads.
func fill(_ rgb: Data) {
  CVPixelBufferLockBaseAddress(frame, [])
  defer { CVPixelBufferUnlockBaseAddress(frame, []) }
  rgb.withUnsafeBytes { (source: UnsafeRawBufferPointer) in
    var src = vImage_Buffer(
      data: UnsafeMutableRawPointer(mutating: source.baseAddress!), height: vImagePixelCount(height),
      width: vImagePixelCount(width), rowBytes: width * 3)
    var dst = vImage_Buffer(
      data: CVPixelBufferGetBaseAddress(frame)!, height: vImagePixelCount(height), width: vImagePixelCount(width),
      rowBytes: CVPixelBufferGetBytesPerRow(frame))
    vImageConvert_RGB888toBGRA8888(&src, nil, 255, &dst, false, vImage_Flags(kvImageNoFlags))
  }
}

/// A one-component float or 8-bit matte of any size -> W*H bytes of alpha.
let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
func alphaBytes(_ matte: CVPixelBuffer) -> Data {
  var image = CIImage(cvPixelBuffer: matte)
  let sx = CGFloat(width) / image.extent.width
  let sy = CGFloat(height) / image.extent.height
  if sx != 1 || sy != 1 { image = image.transformed(by: CGAffineTransform(scaleX: sx, y: sy)) }
  var bytes = Data(count: width * height)
  bytes.withUnsafeMutableBytes { pointer in
    context.render(
      image, toBitmap: pointer.baseAddress!, rowBytes: width, bounds: CGRect(x: 0, y: 0, width: width, height: height),
      format: .R8, colorSpace: nil)
  }
  return bytes
}

/// The followed subject at instance-mask resolution (1 = selected), from the previous frame.
var followed: [UInt8] = []
var followedSize = (0, 0)
var followedArea = 0

func labels(_ observation: VNInstanceMaskObservation) -> ([UInt8], Int, Int) {
  let mask = observation.instanceMask
  CVPixelBufferLockBaseAddress(mask, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
  let w = CVPixelBufferGetWidth(mask)
  let h = CVPixelBufferGetHeight(mask)
  let stride = CVPixelBufferGetBytesPerRow(mask)
  let base = CVPixelBufferGetBaseAddress(mask)!.assumingMemoryBound(to: UInt8.self)
  var out = [UInt8](repeating: 0, count: w * h)
  for y in 0..<h { for x in 0..<w { out[y * w + x] = base[y * stride + x] } }
  return (out, w, h)
}

func select(_ observation: VNInstanceMaskObservation, box: [Float], seedLargest: Bool) -> IndexSet {
  let (map, w, h) = labels(observation)
  var area = [Int](repeating: 0, count: 256)
  var inside = [Int](repeating: 0, count: 256)
  let follow = !followed.isEmpty && followedSize == (w, h)
  // A click arrives as a zero-area box: widen it to one mask pixel so it can land on a label.
  let x0 = max(0, min(w - 1, Int(box[0] * Float(w))))
  let y0 = max(0, min(h - 1, Int(box[1] * Float(h))))
  let x1 = max(x0 + 1, min(w, Int((box[2] * Float(w)).rounded(.up))))
  let y1 = max(y0 + 1, min(h, Int((box[3] * Float(h)).rounded(.up))))
  for y in 0..<h {
    for x in 0..<w {
      let label = Int(map[y * w + x])
      if label == 0 { continue }
      area[label] += 1
      let hit = follow ? followed[y * w + x] == 1 : (x >= x0 && x < x1 && y >= y0 && y < y1)
      if hit { inside[label] += 1 }
    }
  }
  var chosen = IndexSet()
  let point = (x1 - x0) <= 1 && (y1 - y0) <= 1
  for label in observation.allInstances where area[label] > 0 {
    let share = Float(inside[label]) / Float(area[label])
    // Seeding by a click takes the instance under it; by a box, instances mostly inside it.
    let seeded = !seedLargest && (point ? inside[label] > 0 : share >= FOLLOW_OVERLAP)
    if follow ? share >= FOLLOW_OVERLAP : seeded { chosen.insert(label) }
  }
  if seedLargest && chosen.isEmpty {
    // Mode 0 with nothing to follow (first frame, or the subject was lost): the largest instance.
    if let largest = observation.allInstances.max(by: { area[$0] < area[$1] }), area[largest] > 0,
      followedArea == 0 || Float(area[largest]) >= RESEED_AREA_SHARE * Float(followedArea)
    {
      chosen.insert(largest)
    }
  }
  if !chosen.isEmpty {
    followedArea = chosen.reduce(0) { $0 + area[$1] }
    followed = map.map { chosen.contains(Int($0)) ? 1 : 0 }
    followedSize = (w, h)
  }
  return chosen
}

let foreground = VNGenerateForegroundInstanceMaskRequest()
let person = VNGeneratePersonSegmentationRequest()
person.qualityLevel = .accurate
person.outputPixelFormat = kCVPixelFormatType_OneComponent8
// The person plane only gates background clutter at low resolution, so the quick model is enough;
// the accurate one stays for the no-instance fallback, where it IS the matte.
let personGate = VNGeneratePersonSegmentationRequest()
personGate.qualityLevel = .balanced
personGate.outputPixelFormat = kCVPixelFormatType_OneComponent8
let sequence = VNSequenceRequestHandler()
let gateSequence = VNSequenceRequestHandler()

func personMatte(accurate: Bool) -> Data {
  do {
    let request = accurate ? person : personGate
    try (accurate ? sequence : gateSequence).perform([request], on: frame)
    if let matte = request.results?.first?.pixelBuffer { return alphaBytes(matte) }
  } catch {
    FileHandle.standardError.write("person request failed: \(error)\n".data(using: .utf8)!)
  }
  return Data(count: width * height)
}

func respond(status: UInt32, instances: UInt32, alpha: Data) {
  var head = Data()
  withUnsafeBytes(of: status.littleEndian) { head.append(contentsOf: $0) }
  withUnsafeBytes(of: instances.littleEndian) { head.append(contentsOf: $0) }
  output.write(head)
  output.write(alpha)
}

let frameBytes = width * height * 3
while let header = readExactly(28) {
  guard Array(header.prefix(4)) == MAGIC else { fail("bad request magic") }
  let mode = header.subdata(in: 4..<8).withUnsafeBytes { UInt32(littleEndian: $0.load(as: UInt32.self)) }
  let flags = header.subdata(in: 8..<12).withUnsafeBytes { UInt32(littleEndian: $0.load(as: UInt32.self)) }
  let box: [Float] = (0..<4).map { index in
    header.subdata(in: (12 + index * 4)..<(16 + index * 4)).withUnsafeBytes {
      Float(bitPattern: UInt32(littleEndian: $0.load(as: UInt32.self)))
    }
  }
  guard let rgb = readExactly(frameBytes) else { fail("stdin closed before the frame") }
  if flags & 1 == 1 {
    followed = []
    followedArea = 0
  }
  fill(rgb)
  autoreleasepool {
    let handler = VNImageRequestHandler(cvPixelBuffer: frame, options: [:])
    var alpha: Data? = nil
    var count: UInt32 = 0
    var personPlane: Data? = nil
    do {
      try handler.perform([foreground])
      if let observation = foreground.results?.first {
        let chosen = select(observation, box: box, seedLargest: mode == 0)
        if !chosen.isEmpty {
          let matte = try observation.generateScaledMaskForImage(forInstances: chosen, from: handler)
          alpha = alphaBytes(matte)
          count = UInt32(chosen.count)
        }
      }
      if flags & 2 == 2 { personPlane = personMatte(accurate: false) }
      if alpha == nil && mode == 0 {
        let bytes = personMatte(accurate: true)
        if bytes.contains(where: { $0 > 127 }) { alpha = bytes; count = 1 }
      }
    } catch {
      FileHandle.standardError.write("vision request failed: \(error)\n".data(using: .utf8)!)
    }
    if let alpha { respond(status: 0, instances: count, alpha: alpha) }
    else { respond(status: 1, instances: 0, alpha: Data(count: width * height)) }
    if flags & 2 == 2 { output.write(personPlane ?? Data(count: width * height)) }
  }
}
