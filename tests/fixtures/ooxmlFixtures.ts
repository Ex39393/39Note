import JSZip from 'jszip';

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function createSimplePptxFixture(options?: {
  slideCount?: number;
  includeExternalHyperlink?: boolean;
  maliciousSlideXml?: string;
  maliciousRelationshipTarget?: string;
  macroEntry?: boolean;
  imageBytes?: Uint8Array;
  imageContentType?: string;
  imageExtension?: string;
  imageRelationshipType?: string;
  imageRelationshipTargetMode?: 'External';
  useSvgBlip?: boolean;
  slideTexts?: readonly string[];
}): Promise<Uint8Array> {
  const slideCount = options?.slideCount ?? 2;
  const imageExtension = options?.imageExtension ?? 'png';
  const imageContentType = options?.imageContentType ?? 'image/png';
  const imageTarget =
    options?.maliciousRelationshipTarget ?? `../media/image1.${imageExtension}`;
  const zip = new JSZip();
  zip.file(
    '_rels/.rels',
    xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rOfficeDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
      </Relationships>
    `),
  );
  zip.file(
    '[Content_Types].xml',
    xml(`
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Default Extension="${imageExtension}" ContentType="${imageContentType}"/>
        <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
        ${Array.from({ length: slideCount }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}
      </Types>
    `),
  );
  zip.file(
    'ppt/presentation.xml',
    xml(`
      <p:presentation xmlns:p="p" xmlns:r="r">
        <p:sldSz cx="12192000" cy="6858000"/>
        <p:sldIdLst>
          ${Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${300 + index}" r:id="rId${index + 1}"/>`).join('')}
        </p:sldIdLst>
      </p:presentation>
    `),
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        ${Array.from({ length: slideCount }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}
      </Relationships>
    `),
  );
  for (let index = 0; index < slideCount; index += 1) {
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      index === 0 && options?.maliciousSlideXml
        ? options.maliciousSlideXml
        : pptxSlideXml(
            index + 1,
            Boolean(options?.includeExternalHyperlink && index === 0),
            options?.slideTexts?.[index],
            options?.useSvgBlip ?? false,
          ),
    );
    zip.file(
      `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      xml(`
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rImage" Type="${options?.imageRelationshipType ?? 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'}" Target="${imageTarget}"${options?.imageRelationshipTargetMode ? ` TargetMode="${options.imageRelationshipTargetMode}"` : ''}/>
          ${options?.includeExternalHyperlink && index === 0 ? '<Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/reference" TargetMode="External"/>' : ''}
        </Relationships>
      `),
    );
  }
  if (!options?.imageRelationshipTargetMode) {
    zip.file(
      `ppt/media/image1.${imageExtension}`,
      options?.imageBytes ?? tinyPngSignature(),
    );
  }
  if (options?.macroEntry) zip.file('ppt/vbaProject.bin', new Uint8Array([1, 2, 3]));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function createImageDominantPptxFixture(options?: {
  hiddenOverlay?: boolean;
  overlayText?: string;
  imageBytes?: Uint8Array;
}): Promise<Uint8Array> {
  return createSimplePptxFixture({
    slideCount: 1,
    imageBytes: options?.imageBytes,
    maliciousSlideXml: imageDominantSlideXml(
      options?.overlayText ?? 'Ghost overlay should not be visible',
      options?.hiddenOverlay ?? true,
    ),
  });
}

export async function createSimpleDocxFixture(options?: {
  documentXml?: string;
  includeExternalHyperlink?: boolean;
  imageBytes?: Uint8Array;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '_rels/.rels',
    xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rOfficeDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>
    `),
  );
  zip.file(
    '[Content_Types].xml',
    xml(`
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Default Extension="png" ContentType="image/png"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
      </Types>
    `),
  );
  zip.file('word/document.xml', options?.documentXml ?? docxDocumentXml());
  zip.file(
    'word/_rels/document.xml.rels',
    xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
        <Relationship Id="rImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
        ${options?.includeExternalHyperlink ? '<Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/reference" TargetMode="External"/>' : ''}
      </Relationships>
    `),
  );
  zip.file(
    'word/styles.xml',
    xml(`
      <w:styles xmlns:w="w">
        <w:style w:type="paragraph" w:styleId="Heading1">
          <w:name w:val="Heading 1"/>
          <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
        </w:style>
      </w:styles>
    `),
  );
  zip.file('word/media/image1.png', options?.imageBytes ?? tinyPngSignature());
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export function pptxSource(bytes: Uint8Array) {
  return {
    documentId: 'document-pptx',
    fileName: 'Lecture.pptx',
    mimeType: PPTX_MIME,
    bytes,
  };
}

export function docxSource(bytes: Uint8Array) {
  return {
    documentId: 'document-docx',
    fileName: 'Article.docx',
    mimeType: DOCX_MIME,
    bytes,
  };
}

function pptxSlideXml(
  slideNumber: number,
  hyperlink: boolean,
  slideText = `Slide ${slideNumber} searchable text`,
  useSvgBlip = false,
): string {
  return xml(`
    <p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r">
      <p:cSld><p:spTree>
        <p:nvGrpSpPr><p:cNvPr id="1" name="Root"/></p:nvGrpSpPr>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="Title ${slideNumber}"/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="100000" y="200000"/><a:ext cx="5000000" cy="1000000"/></a:xfrm>
            <a:solidFill><a:srgbClr val="EEEEEE"/></a:solidFill>
          </p:spPr>
          <p:txBody><a:p><a:r><a:rPr b="1" sz="2400">${hyperlink ? '<a:hlinkClick r:id="rLink"/>' : ''}</a:rPr><a:t>${slideText}</a:t></a:r></a:p></p:txBody>
        </p:sp>
        <p:pic>
          <p:nvPicPr><p:cNvPr id="3" name="Diagram"/></p:nvPicPr>
          <p:blipFill>${
            useSvgBlip
              ? `<a:blip><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rImage"/></a:ext></a:extLst></a:blip>`
              : '<a:blip r:embed="rImage"/>'
          }</p:blipFill>
          <p:spPr><a:xfrm><a:off x="100000" y="1500000"/><a:ext cx="2000000" cy="2000000"/></a:xfrm></p:spPr>
        </p:pic>
      </p:spTree></p:cSld>
    </p:sld>
  `);
}

export function passiveSvgImage(options?: {
  activeMarkup?: string;
  rootAttributes?: string;
}): Uint8Array {
  return new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"${options?.rootAttributes ? ` ${options.rootAttributes}` : ''}><path fill="#004D40" d="M4 4h40v40H4z"/>${options?.activeMarkup ?? ''}</svg>`,
  );
}

export function tinyJpegImage(): Uint8Array {
  const base64 =
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=';
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function imageDominantSlideXml(overlayText: string, hidden: boolean): string {
  return xml(`
    <p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r">
      <p:cSld><p:spTree>
        <p:nvGrpSpPr><p:cNvPr id="1" name="Root"/></p:nvGrpSpPr>
        <p:pic>
          <p:nvPicPr><p:cNvPr id="2" name="Full-slide raster"/></p:nvPicPr>
          <p:blipFill><a:blip r:embed="rImage"/></p:blipFill>
          <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm></p:spPr>
        </p:pic>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="3" name="Imported hidden text"${hidden ? ' hidden="1"' : ''}/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="800000" y="2200000"/><a:ext cx="10500000" cy="1200000"/></a:xfrm>
            <a:noFill/>
          </p:spPr>
          <p:txBody><a:p><a:r><a:rPr sz="2800"/><a:t>${overlayText}</a:t></a:r></a:p></p:txBody>
        </p:sp>
      </p:spTree></p:cSld>
    </p:sld>
  `);
}

function docxDocumentXml(): string {
  return xml(`
    <w:document xmlns:w="w" xmlns:w14="w14" xmlns:a="a" xmlns:r="r" xmlns:wp="wp">
      <w:body>
        <w:p w14:paraId="A1B2C3D4"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Research heading</w:t></w:r></w:p>
        <w:p w14:paraId="B1B2C3D4"><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>First list item with anchor text</w:t></w:r></w:p>
        <w:p w14:paraId="C1B2C3D4"><w:r><w:drawing><wp:docPr descr="Figure"><a:blip r:embed="rImage"/></wp:docPr></w:drawing></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p w14:paraId="D1B2C3D4"><w:r><w:t>Table cell value</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <w:sectPr/>
      </w:body>
    </w:document>
  `);
}

function tinyPngSignature(): Uint8Array {
  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0,
    1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100,
    248, 15, 0, 1, 5, 1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96,
    130,
  ]);
}

function xml(value: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${value.trim()}`;
}
