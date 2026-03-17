from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

MISSING_DEPENDENCIES = []

try:
  import cv2
except ModuleNotFoundError:
  cv2 = None
  MISSING_DEPENDENCIES.append('opencv-python-headless')

try:
  import easyocr
except ModuleNotFoundError:
  easyocr = None
  MISSING_DEPENDENCIES.append('easyocr')

try:
  import numpy as np
except ModuleNotFoundError:
  np = None
  MISSING_DEPENDENCIES.append('numpy')

SUPPORTED_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp'}
NODE_NOISE_REPLACEMENTS = {
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '`': "'",
  '´': "'",
  '–': '-',
  '—': '-',
  '[': '1',
  ']': '1',
  '{': '1',
  '}': '1',
  '|': 'I',
  '¦': 'I',
  '•': '.',
  '·': '.',
  'º': 'o',
  '°': 'o',
}
ORIENTATION_KEYWORDS = (
  'recebemos',
  'recebimento',
  'data',
  'assinatura',
  'recebedor',
  'nota fiscal',
  'nfe',
  'serie',
)
RECEIPT_KEYWORDS = (
  'recebemos',
  'data de recebimento',
  'assinatura',
  'recebedor',
  'recebedora',
  'canhoto',
)
SIGNATURE_KEYWORDS = (
  'assinatura',
  'recebedor',
  'recebedora',
)
DATE_REGEX = re.compile(r'\b([0-3]?\d[\/\-.][01]?\d[\/\-.](?:19|20)?\d{2})\b')
INVOICE_CONTEXT_REGEXES = (
  re.compile(r'(?:nf\s*e|nfe|nota fiscal(?: eletronica)?)(?:\s+(?:numero|n\s*o|no|nro))?[^\d]{0,20}(\d{6,9})', re.IGNORECASE),
  re.compile(r'(?:numero|n\s*o|no|nro)[^\d]{0,10}(\d{6,9})', re.IGNORECASE),
)
INVOICE_DIGIT_REGEX = re.compile(r'\b\d{6,9}\b')


@dataclass
class OCRLine:
  text: str
  confidence: float
  bbox: list[list[float]]
  source_variant: str

  @property
  def left(self) -> float:
    return min(point[0] for point in self.bbox)

  @property
  def top(self) -> float:
    return min(point[1] for point in self.bbox)

  @property
  def width(self) -> float:
    return max(point[0] for point in self.bbox) - min(point[0] for point in self.bbox)

  @property
  def height(self) -> float:
    return max(point[1] for point in self.bbox) - min(point[1] for point in self.bbox)


@dataclass
class InvoiceCandidate:
  invoice_number: str
  score: float
  confidence: float
  source_text: str
  source_variant: str


def normalize_whitespace(value: str) -> str:
  return re.sub(r'\s+', ' ', str(value or '')).strip()


def strip_accents(value: str) -> str:
  return ''.join(
    character
    for character in unicodedata.normalize('NFD', str(value or ''))
    if unicodedata.category(character) != 'Mn'
  )


def normalize_ocr_noise(value: str) -> str:
  raw = str(value or '')
  normalized = ''.join(NODE_NOISE_REPLACEMENTS.get(character, character) for character in raw)
  return normalize_whitespace(normalized)


def to_searchable_text(value: str) -> str:
  normalized = strip_accents(normalize_ocr_noise(value)).lower()
  normalized = re.sub(r'[^a-z0-9\s]', ' ', normalized)
  return normalize_whitespace(normalized)


def digits_only(value: str) -> str:
  return re.sub(r'\D+', '', str(value or ''))


def load_image(image_path: Path) -> Any:
  raw_bytes = np.fromfile(str(image_path), dtype=np.uint8)
  image = cv2.imdecode(raw_bytes, cv2.IMREAD_COLOR)
  if image is None:
    raise ValueError(f'Nao foi possivel carregar a imagem: {image_path}')
  return image


def save_image(image_path: Path, image: Any) -> None:
  image_path.parent.mkdir(parents=True, exist_ok=True)
  suffix = image_path.suffix or '.png'
  success, encoded = cv2.imencode(suffix, image)
  if not success:
    raise ValueError(f'Nao foi possivel salvar a imagem: {image_path}')
  image_path.write_bytes(encoded.tobytes())


def rotate_quadrants(image: Any, angle: int) -> Any:
  normalized_angle = angle % 360
  if normalized_angle == 0:
    return image.copy()
  if normalized_angle == 90:
    return cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
  if normalized_angle == 180:
    return cv2.rotate(image, cv2.ROTATE_180)
  if normalized_angle == 270:
    return cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
  raise ValueError(f'Angulo discreto nao suportado: {angle}')


def rotate_bound(image: Any, angle: float) -> Any:
  if abs(angle) < 1e-6:
    return image.copy()

  height, width = image.shape[:2]
  center = (width / 2.0, height / 2.0)
  rotation_matrix = cv2.getRotationMatrix2D(center, angle, 1.0)

  cosine = abs(rotation_matrix[0, 0])
  sine = abs(rotation_matrix[0, 1])
  bound_width = int((height * sine) + (width * cosine))
  bound_height = int((height * cosine) + (width * sine))

  rotation_matrix[0, 2] += (bound_width / 2.0) - center[0]
  rotation_matrix[1, 2] += (bound_height / 2.0) - center[1]

  return cv2.warpAffine(
    image,
    rotation_matrix,
    (bound_width, bound_height),
    flags=cv2.INTER_CUBIC,
    borderMode=cv2.BORDER_REPLICATE,
  )


def resize_longest_edge(image: Any, *, min_edge: int | None = None, max_edge: int | None = None) -> Any:
  height, width = image.shape[:2]
  longest_edge = max(height, width)
  shortest_edge = min(height, width)
  scale = 1.0

  if max_edge and longest_edge > max_edge:
    scale = min(scale, max_edge / float(longest_edge))

  if min_edge and shortest_edge < min_edge:
    scale = max(scale, min_edge / float(shortest_edge))

  if abs(scale - 1.0) < 0.01:
    return image.copy()

  interpolation = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
  new_width = max(1, int(round(width * scale)))
  new_height = max(1, int(round(height * scale)))
  return cv2.resize(image, (new_width, new_height), interpolation=interpolation)


def cleanup_receipt_image(image: Any) -> dict[str, Any]:
  if image.ndim == 3:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
  else:
    gray = image.copy()

  gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
  denoised = cv2.fastNlMeansDenoising(gray, None, 17, 7, 21)
  enhanced = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8)).apply(denoised)
  softened = cv2.GaussianBlur(enhanced, (3, 3), 0)
  _, binary = cv2.threshold(softened, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
  binary = cv2.medianBlur(binary, 3)
  binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8), iterations=1)
  binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), iterations=1)

  # EasyOCR tende a responder melhor com texto escuro sobre fundo claro.
  if float(binary.mean()) < 127.0:
    binary = cv2.bitwise_not(binary)

  return {
    'gray': enhanced,
    'binary': binary,
  }


def estimate_skew_angle(binary_image: Any, *, max_abs_angle: float = 12.0) -> float:
  inverted = cv2.bitwise_not(binary_image)
  coordinates = np.column_stack(np.where(inverted > 0))
  if coordinates.shape[0] < 120:
    return 0.0

  angle = cv2.minAreaRect(coordinates)[-1]
  if angle < -45:
    angle = -(90 + angle)
  else:
    angle = -angle

  if abs(angle) > max_abs_angle:
    return 0.0
  return float(round(angle, 3))


def parse_easyocr_lines(raw_results: list[Any], *, source_variant: str) -> list[OCRLine]:
  lines = []
  for raw_item in raw_results:
    if not isinstance(raw_item, (list, tuple)) or len(raw_item) < 3:
      continue

    bbox = [[float(point[0]), float(point[1])] for point in raw_item[0]]
    text = normalize_ocr_noise(raw_item[1])
    confidence = max(0.0, min(1.0, float(raw_item[2])))
    if not text:
      continue

    lines.append(OCRLine(
      text=text,
      confidence=confidence,
      bbox=bbox,
      source_variant=source_variant,
    ))
  return lines


def deduplicate_lines(lines: list[OCRLine]) -> list[OCRLine]:
  deduplicated: dict[tuple[str, int], OCRLine] = {}
  for line in lines:
    key = (to_searchable_text(line.text), int(round(line.top / 14.0)))
    current = deduplicated.get(key)
    if current is None or line.confidence > current.confidence:
      deduplicated[key] = line

  return sorted(deduplicated.values(), key=lambda item: (round(item.top / 10.0), item.left))


def compute_global_confidence(lines: list[OCRLine]) -> float:
  if not lines:
    return 0.0

  weighted_sum = 0.0
  total_weight = 0.0
  for line in lines:
    weight = max(4, len(line.text.strip()))
    weighted_sum += line.confidence * weight
    total_weight += weight

  if total_weight <= 0:
    return 0.0
  return round(weighted_sum / total_weight, 4)


def score_orientation(lines: list[OCRLine]) -> float:
  if not lines:
    return 0.0

  searchable = to_searchable_text(' '.join(line.text for line in lines))
  keyword_hits = sum(1 for keyword in ORIENTATION_KEYWORDS if keyword in searchable)
  average_confidence = compute_global_confidence(lines)
  horizontal_lines = sum(1 for line in lines if line.width >= max(12.0, line.height * 1.25))
  horizontal_ratio = horizontal_lines / float(len(lines))
  text_density = min(1.0, sum(len(line.text) for line in lines) / 110.0)
  has_date = 1.0 if DATE_REGEX.search(' '.join(line.text for line in lines)) else 0.0
  has_invoice_context = 1.0 if any(regex.search(searchable) for regex in INVOICE_CONTEXT_REGEXES) else 0.0

  return round(
    (average_confidence * 0.48)
    + (min(1.0, keyword_hits / 4.0) * 0.22)
    + (has_date * 0.11)
    + (has_invoice_context * 0.11)
    + (horizontal_ratio * 0.05)
    + (text_density * 0.03),
    4,
  )


def run_easyocr(reader: Any, image: Any) -> list[Any]:
  return reader.readtext(
    np.ascontiguousarray(image),
    detail=1,
    paragraph=False,
    decoder='greedy',
    beamWidth=5,
    text_threshold=0.4,
    low_text=0.2,
    link_threshold=0.2,
    width_ths=0.7,
  )


def detect_best_rotation(reader: Any, image: Any) -> tuple[int, list[dict[str, Any]]]:
  candidates = []
  probe_base = resize_longest_edge(image, max_edge=1280)

  for angle in (0, 90, 180, 270):
    rotated = rotate_quadrants(probe_base, angle)
    prepared = cleanup_receipt_image(rotated)
    lines = parse_easyocr_lines(run_easyocr(reader, prepared['gray']), source_variant=f'rotation_probe_{angle}')
    score = score_orientation(lines)
    candidates.append({
      'angle': angle,
      'score': score,
      'line_count': len(lines),
      'model_confidence': compute_global_confidence(lines),
      'text_length': sum(len(line.text) for line in lines),
    })

  candidates.sort(
    key=lambda item: (
      item['score'],
      item['model_confidence'],
      item['line_count'],
      item['text_length'],
    ),
    reverse=True,
  )
  best_angle = int(candidates[0]['angle']) if candidates else 0
  return best_angle, candidates


def extract_invoice_number(lines: list[OCRLine], *, preferred_lengths: tuple[int, ...]) -> dict[str, Any]:
  candidates: list[InvoiceCandidate] = []
  full_text = '\n'.join(line.text for line in lines)
  searchable_full_text = to_searchable_text(full_text)

  def maybe_add_candidate(match_value: str, *, source_text: str, source_variant: str, line_confidence: float, contextual: bool) -> None:
    digits = digits_only(match_value)
    if not digits:
      return
    if len(digits) < 6 or len(digits) > 9:
      return

    score = (line_confidence * 0.48)
    if len(digits) in preferred_lengths:
      score += 0.28
    if contextual:
      score += 0.2
    if len(source_text.strip()) <= 24:
      score += 0.08
    if re.search(r'(?:nf|nfe|nota fiscal|numero|n o|no|nro)', to_searchable_text(source_text)):
      score += 0.12

    candidates.append(InvoiceCandidate(
      invoice_number=digits,
      score=round(min(0.99, score), 4),
      confidence=round(min(0.99, (line_confidence * 0.7) + (0.2 if contextual else 0.0)), 4),
      source_text=normalize_ocr_noise(source_text),
      source_variant=source_variant,
    ))

  for line in lines:
    searchable_line = to_searchable_text(line.text)
    for regex in INVOICE_CONTEXT_REGEXES:
      for match in regex.finditer(searchable_line):
        maybe_add_candidate(
          match.group(1),
          source_text=line.text,
          source_variant=line.source_variant,
          line_confidence=line.confidence,
          contextual=True,
        )

    for match in INVOICE_DIGIT_REGEX.finditer(line.text):
      maybe_add_candidate(
        match.group(0),
        source_text=line.text,
        source_variant=line.source_variant,
        line_confidence=line.confidence,
        contextual=bool(re.search(r'(?:nf|nfe|nota fiscal|numero|n o|no|nro)', searchable_line)),
      )

  for regex in INVOICE_CONTEXT_REGEXES:
    for match in regex.finditer(searchable_full_text):
      maybe_add_candidate(
        match.group(1),
        source_text=full_text,
        source_variant='full_text',
        line_confidence=compute_global_confidence(lines),
        contextual=True,
      )

  if not candidates:
    return {
      'invoice_number': None,
      'invoice_confidence': 0.0,
      'invoice_source_text': None,
      'invoice_source_variant': None,
    }

  candidates.sort(
    key=lambda item: (
      item.score,
      item.confidence,
      len(item.source_text),
    ),
    reverse=True,
  )
  best = candidates[0]
  return {
    'invoice_number': best.invoice_number,
    'invoice_confidence': best.confidence,
    'invoice_source_text': best.source_text,
    'invoice_source_variant': best.source_variant,
  }


def normalize_brazilian_date(raw_value: str) -> tuple[str | None, str | None]:
  cleaned = normalize_ocr_noise(raw_value).replace('.', '/').replace('-', '/')
  parts = cleaned.split('/')
  if len(parts) != 3:
    return None, None

  day, month, year = parts
  if len(year) == 2:
    year = f'20{year}'

  try:
    parsed = datetime.strptime(f'{day}/{month}/{year}', '%d/%m/%Y')
  except ValueError:
    return None, None

  return parsed.strftime('%d/%m/%Y'), parsed.date().isoformat()


def extract_receipt_date(lines: list[OCRLine]) -> dict[str, Any]:
  best_match = None

  for line in lines:
    searchable_line = to_searchable_text(line.text)
    for match in DATE_REGEX.finditer(line.text):
      normalized_date, iso_date = normalize_brazilian_date(match.group(1))
      if not normalized_date:
        continue

      confidence = line.confidence
      if 'data' in searchable_line or 'recebimento' in searchable_line:
        confidence = min(0.99, confidence + 0.15)

      candidate = {
        'receipt_date': normalized_date,
        'receipt_date_iso': iso_date,
        'date_confidence': round(confidence, 4),
        'date_source_text': normalize_ocr_noise(line.text),
      }
      if best_match is None or candidate['date_confidence'] > best_match['date_confidence']:
        best_match = candidate

  if best_match is None:
    return {
      'receipt_date': None,
      'receipt_date_iso': None,
      'date_confidence': 0.0,
      'date_source_text': None,
    }
  return best_match


def extract_receipt_markers(text: str) -> dict[str, Any]:
  searchable = to_searchable_text(text)
  found_keywords = [keyword for keyword in RECEIPT_KEYWORDS if keyword in searchable]
  found_signature_keywords = [keyword for keyword in SIGNATURE_KEYWORDS if keyword in searchable]

  return {
    'receipt_marker_found': bool(found_keywords),
    'signature_marker_found': bool(found_signature_keywords),
    'receipt_keywords': found_keywords,
  }


def extract_structured_fields(lines: list[OCRLine], *, preferred_lengths: tuple[int, ...]) -> dict[str, Any]:
  full_text = '\n'.join(line.text for line in lines)
  fields = {}
  fields.update(extract_invoice_number(lines, preferred_lengths=preferred_lengths))
  fields.update(extract_receipt_date(lines))
  fields.update(extract_receipt_markers(full_text))
  return fields


def build_reader(languages: list[str], gpu: bool) -> Any:
  return easyocr.Reader(languages, gpu=gpu)


def process_image(
  *,
  image_path: Path,
  reader: Any,
  preferred_lengths: tuple[int, ...],
  correct_rotation: bool,
  debug_dir: Path | None,
) -> dict[str, Any]:
  started = time.perf_counter()
  debug_payload: dict[str, Any] = {}

  try:
    source_image = load_image(image_path)
    coarse_rotation = 0
    orientation_candidates: list[dict[str, Any]] = []

    if correct_rotation:
      coarse_rotation, orientation_candidates = detect_best_rotation(reader, source_image)
      source_image = rotate_quadrants(source_image, coarse_rotation)

    prepared = cleanup_receipt_image(source_image)
    fine_skew = estimate_skew_angle(prepared['binary'])
    if abs(fine_skew) >= 0.35:
      source_image = rotate_bound(source_image, fine_skew)
      prepared = cleanup_receipt_image(source_image)

    gray_for_ocr = resize_longest_edge(prepared['gray'], min_edge=1200, max_edge=2200)
    binary_for_ocr = resize_longest_edge(prepared['binary'], min_edge=1200, max_edge=2200)

    raw_lines = []
    raw_lines.extend(parse_easyocr_lines(run_easyocr(reader, gray_for_ocr), source_variant='gray'))
    raw_lines.extend(parse_easyocr_lines(run_easyocr(reader, binary_for_ocr), source_variant='binary'))

    lines = deduplicate_lines(raw_lines)
    full_text = '\n'.join(line.text for line in lines)
    structured_fields = extract_structured_fields(lines, preferred_lengths=preferred_lengths)
    model_confidence = compute_global_confidence(lines)

    if debug_dir:
      file_stem = image_path.stem
      debug_image_dir = debug_dir / file_stem
      save_image(debug_image_dir / 'rotated_source.png', source_image)
      save_image(debug_image_dir / 'preprocessed_gray.png', prepared['gray'])
      save_image(debug_image_dir / 'preprocessed_binary.png', prepared['binary'])
      debug_payload = {
        'debug_dir': str(debug_image_dir),
      }

    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
    return {
      'file_name': image_path.name,
      'file_path': str(image_path.resolve()),
      'status': 'ok',
      'rotation_angle': coarse_rotation,
      'fine_skew_angle': fine_skew,
      'orientation_candidates': orientation_candidates,
      'text_extracted': full_text,
      'text_normalized': to_searchable_text(full_text),
      'model_confidence': model_confidence,
      'processing_time_ms': elapsed_ms,
      'ocr_line_count': len(lines),
      'error': None,
      **structured_fields,
      **debug_payload,
    }
  except Exception as error:  # noqa: BLE001
    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
    return {
      'file_name': image_path.name,
      'file_path': str(image_path.resolve()),
      'status': 'error',
      'rotation_angle': None,
      'fine_skew_angle': None,
      'orientation_candidates': [],
      'text_extracted': '',
      'text_normalized': '',
      'model_confidence': 0.0,
      'processing_time_ms': elapsed_ms,
      'ocr_line_count': 0,
      'invoice_number': None,
      'invoice_confidence': 0.0,
      'invoice_source_text': None,
      'invoice_source_variant': None,
      'receipt_date': None,
      'receipt_date_iso': None,
      'date_confidence': 0.0,
      'date_source_text': None,
      'receipt_marker_found': False,
      'signature_marker_found': False,
      'receipt_keywords': [],
      'error': f'{error.__class__.__name__}: {error}',
    }


def find_images(input_dir: Path, *, extensions: set[str], max_files: int | None) -> list[Path]:
  files = [
    candidate
    for candidate in sorted(input_dir.iterdir())
    if candidate.is_file()
    and candidate.suffix.lower() in extensions
  ]
  if max_files is not None:
    return files[:max_files]
  return files


def build_summary(records: list[dict[str, Any]], *, started_at: float, input_dir: Path) -> dict[str, Any]:
  ok_records = [record for record in records if record['status'] == 'ok']
  error_records = [record for record in records if record['status'] == 'error']

  def average(field_name: str) -> float:
    if not ok_records:
      return 0.0
    return round(
      sum(float(record.get(field_name, 0.0) or 0.0) for record in ok_records) / len(ok_records),
      4,
    )

  return {
    'input_dir': str(input_dir.resolve()),
    'generated_at': datetime.utcnow().isoformat(timespec='seconds') + 'Z',
    'total_files': len(records),
    'processed_ok': len(ok_records),
    'processed_error': len(error_records),
    'avg_model_confidence': average('model_confidence'),
    'avg_processing_time_ms': average('processing_time_ms'),
    'invoice_found_count': sum(1 for record in ok_records if record.get('invoice_number')),
    'date_found_count': sum(1 for record in ok_records if record.get('receipt_date')),
    'receipt_marker_count': sum(1 for record in ok_records if record.get('receipt_marker_found')),
    'total_elapsed_ms': round((time.perf_counter() - started_at) * 1000.0, 2),
  }


def write_json_report(output_path: Path, payload: dict[str, Any]) -> None:
  output_path.parent.mkdir(parents=True, exist_ok=True)
  output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')


def write_csv_report(output_path: Path, records: list[dict[str, Any]]) -> None:
  output_path.parent.mkdir(parents=True, exist_ok=True)
  fieldnames = [
    'file_name',
    'status',
    'rotation_angle',
    'fine_skew_angle',
    'model_confidence',
    'processing_time_ms',
    'ocr_line_count',
    'invoice_number',
    'invoice_confidence',
    'receipt_date',
    'receipt_date_iso',
    'date_confidence',
    'receipt_marker_found',
    'signature_marker_found',
    'receipt_keywords',
    'text_extracted',
    'text_normalized',
    'error',
    'file_path',
  ]

  with output_path.open('w', newline='', encoding='utf-8') as handle:
    writer = csv.DictWriter(handle, fieldnames=fieldnames)
    writer.writeheader()
    for record in records:
      csv_record = dict(record)
      csv_record['receipt_keywords'] = ', '.join(record.get('receipt_keywords') or [])
      writer.writerow({field: csv_record.get(field) for field in fieldnames})


def ensure_dependencies() -> None:
  if not MISSING_DEPENDENCIES:
    return

  unique_dependencies = ', '.join(sorted(set(MISSING_DEPENDENCIES)))
  raise SystemExit(
    'Dependencias Python ausentes. Instale antes de executar:\n'
    f'  pip install -r requirements-easyocr.txt\n'
    f'Modulos faltando: {unique_dependencies}'
  )


def parse_arguments() -> argparse.Namespace:
  parser = argparse.ArgumentParser(
    description='Benchmark em Python para OCR de canhotos logísticos com EasyOCR + OpenCV.',
  )
  parser.add_argument(
    '--input-dir',
    type=Path,
    default=Path('test-images'),
    help='Pasta com as imagens de entrada. Padrao: test-images',
  )
  parser.add_argument(
    '--output-path',
    type=Path,
    default=Path('outputs/easyocr-benchmark/report.json'),
    help='Arquivo final do relatorio. O formato respeita --format.',
  )
  parser.add_argument(
    '--format',
    choices=('json', 'csv', 'both'),
    default='json',
    help='Formato do relatorio final.',
  )
  parser.add_argument(
    '--debug-dir',
    type=Path,
    default=None,
    help='Diretorio opcional para salvar a imagem corrigida e preprocessada.',
  )
  parser.add_argument(
    '--languages',
    default='pt,en',
    help='Idiomas do EasyOCR separados por virgula. Padrao: pt,en',
  )
  parser.add_argument(
    '--gpu',
    action='store_true',
    help='Ativa GPU no EasyOCR quando disponivel.',
  )
  parser.add_argument(
    '--max-files',
    type=int,
    default=None,
    help='Limita quantas imagens serao processadas.',
  )
  parser.add_argument(
    '--nf-lengths',
    default='7,8',
    help='Tamanhos aceitos para a NF separados por virgula. Padrao: 7,8',
  )
  parser.add_argument(
    '--disable-rotation-correction',
    action='store_true',
    help='Desliga a deteccao e correcao automatica de rotacao.',
  )
  return parser.parse_args()


def resolve_output_paths(output_path: Path, report_format: str) -> list[tuple[str, Path]]:
  if report_format == 'json':
    return [('json', output_path if output_path.suffix == '.json' else output_path.with_suffix('.json'))]
  if report_format == 'csv':
    return [('csv', output_path if output_path.suffix == '.csv' else output_path.with_suffix('.csv'))]

  base_path = output_path.with_suffix('') if output_path.suffix else output_path
  return [
    ('json', base_path.with_suffix('.json')),
    ('csv', base_path.with_suffix('.csv')),
  ]


def main() -> int:
  args = parse_arguments()
  ensure_dependencies()

  input_dir: Path = args.input_dir
  if not input_dir.exists() or not input_dir.is_dir():
    raise SystemExit(f'Pasta de entrada inexistente: {input_dir}')

  preferred_lengths = tuple(
    sorted({
      int(item.strip())
      for item in str(args.nf_lengths).split(',')
      if item.strip()
    })
  ) or (7, 8)
  languages = [item.strip() for item in str(args.languages).split(',') if item.strip()]
  images = find_images(input_dir, extensions=SUPPORTED_EXTENSIONS, max_files=args.max_files)
  if not images:
    raise SystemExit(f'Nenhuma imagem encontrada em {input_dir}')

  started_at = time.perf_counter()
  reader = build_reader(languages, args.gpu)
  debug_dir = args.debug_dir
  if debug_dir is not None:
    debug_dir.mkdir(parents=True, exist_ok=True)

  records = []
  for index, image_path in enumerate(images, start=1):
    print(f'[{index}/{len(images)}] Processando {image_path.name}...')
    record = process_image(
      image_path=image_path,
      reader=reader,
      preferred_lengths=preferred_lengths,
      correct_rotation=not args.disable_rotation_correction,
      debug_dir=debug_dir,
    )
    records.append(record)
    status = record['status']
    confidence = record['model_confidence']
    duration = record['processing_time_ms']
    invoice_number = record.get('invoice_number') or '-'
    print(f'    status={status} nf={invoice_number} confidence={confidence:.4f} time_ms={duration:.2f}')

  summary = build_summary(records, started_at=started_at, input_dir=input_dir)
  payload = {
    'generator': 'easyocr_receipt_benchmark',
    'config': {
      'input_dir': str(input_dir.resolve()),
      'languages': languages,
      'gpu': bool(args.gpu),
      'nf_lengths': preferred_lengths,
      'rotation_correction': not args.disable_rotation_correction,
      'debug_dir': str(debug_dir.resolve()) if debug_dir else None,
    },
    'summary': summary,
    'records': records,
  }

  for report_format, destination in resolve_output_paths(args.output_path, args.format):
    if report_format == 'json':
      write_json_report(destination, payload)
    else:
      write_csv_report(destination, records)
    print(f'Relatorio {report_format.upper()} salvo em {destination}')

  print(json.dumps(summary, ensure_ascii=False, indent=2))
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
