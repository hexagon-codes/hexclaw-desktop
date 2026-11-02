import pdf from '@/assets/pdf-file.png'
import word from '@/assets/file-types/file_type_word.svg'
import excel from '@/assets/file-types/file_type_excel.svg'
import powerpoint from '@/assets/file-types/file_type_powerpoint.svg'
import csv from '@/assets/file-types/file_type_csv.svg'
import markdown from '@/assets/file-types/file_type_markdown.svg'
import html from '@/assets/file-types/file_type_html.svg'
import json from '@/assets/file-types/file_type_json.svg'
import text from '@/assets/file-types/file_type_text.svg'
import epub from '@/assets/file-types/file_type_epub.svg'
import odt from '@/assets/file-types/file_type_libreoffice_writer.svg'
import zip from '@/assets/file-types/file_type_zip.svg'
import file from '@/assets/file-types/default_file.svg'

const icons: Record<string, string> = {
  pdf, doc: word, docx: word, xls: excel, xlsx: excel, ppt: powerpoint, pptx: powerpoint,
  csv, md: markdown, markdown, html, htm: html, json, txt: text, rtf: text, epub, odt,
  zip, rar: zip, '7z': zip, gz: zip, tar: zip,
}
const mimeExtensions: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv', 'text/markdown': 'md', 'text/html': 'html',
  'application/json': 'json', 'text/plain': 'txt', 'application/rtf': 'rtf',
  'text/rtf': 'rtf', 'application/epub+zip': 'epub',
  'application/vnd.oasis.opendocument.text': 'odt', 'application/zip': 'zip',
}

/** 图标只描述已有文件，不声明导出或预览能力。 */
export function fileTypeInfo(filename: string, mime = '') {
  const extension = filename.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
    || mimeExtensions[mime.split(';')[0]?.trim().toLowerCase() ?? ''] || ''
  return { icon: icons[extension] ?? file, label: extension.toUpperCase(), isPdf: extension === 'pdf' }
}
