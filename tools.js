// tools.js
// Defines the framework tools that the LLM can call to construct the app.
// Each tool mutates an in-memory `pages` object and later we wire Express routes from it.

/**
 * In-memory page store shape:
 * pages[path] = {
 *   content: string,              // Page BODY content (HTML generated from plain-English)
 *   dynamic: Array<{              // optional dynamic replacements
 *     placeholder: string,
 *     type: 'CURRENT_TIME'
 *   }>
 * }
 */

export const tools = {
  /**
   * create_page({ path, content })
   * Stores page BODY content for a route path. Author content in plain English; the LLM will generate HTML.
   */
  async create_page(ctx, args) {
    const { pages } = ctx;
    const { path, content } = args || {};

    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error('create_page: "path" must be a string that starts with "/"');
    }
    if (typeof content !== 'string') {
      throw new Error('create_page: "content" must be a string');
    }

    pages[path] = pages[path] || { content: '', dynamic: [] };
    pages[path].content = content;
  },
  
  /**
   * add_asset({ path, asset, alt, placement, placeholder, className, width, height })
   * Inserts an asset (currently images) into a page's BODY content. The asset should
   * exist under the local `assets/` directory (e.g., `assets/images/test.png`).
   * 
   * Placement options:
   * - 'append' (default): append HTML to the end of the body content
   * - 'prepend': prepend HTML to the start of the body content
   * - 'replace_placeholder': replace the first occurrence of `placeholder` with the HTML
   */
  async add_asset(ctx, args) {
    const { pages } = ctx;
    const {
      path,
      asset, // e.g., 'test.png' or 'images/test.png' or 'assets/images/test.png'
      alt,
      placement = 'append',
      placeholder,
      className,
      width,
      height,
    } = args || {};

    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error('add_asset: "path" must be a string that starts with "/"');
    }
    if (typeof asset !== 'string' || asset.length === 0) {
      throw new Error('add_asset: "asset" must be a non-empty string');
    }

    // Normalize to a URL under /assets
    const norm = String(asset).replace(/^\\+|^\/+/, '').replace(/\\/g, '/');
    let src = '';
    if (norm.startsWith('assets/')) {
      src = '/' + norm;
    } else if (norm.startsWith('images/')) {
      src = '/assets/' + norm;
    } else {
      src = '/assets/images/' + norm;
    }

    const attrs = [
      `src="${src}"`,
      `alt="${alt != null ? String(alt) : ''}"`,
    ];
    if (className) attrs.push(`class="${String(className)}"`);
    if (width) attrs.push(`width="${String(width)}"`);
    if (height) attrs.push(`height="${String(height)}"`);
    const html = `<img ${attrs.join(' ')} />`;

    pages[path] = pages[path] || { content: '', dynamic: [] };
    const current = pages[path].content || '';
    if (placement === 'replace_placeholder' && typeof placeholder === 'string' && placeholder.length > 0) {
      pages[path].content = current.replace(placeholder, html);
    } else if (placement === 'prepend') {
      pages[path].content = html + current;
    } else {
      pages[path].content = current + html;
    }
  },

  /**
   * add_dynamic_content({ path, placeholder, type })
   * Notes that a specific placeholder should be replaced dynamically.
   * PoC supports only type === 'CURRENT_TIME'.
   */
  async add_dynamic_content(ctx, args) {
    const { pages } = ctx;
    const { path, placeholder, type } = args || {};

    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error('add_dynamic_content: "path" must be a string that starts with "/"');
    }
    if (typeof placeholder !== 'string' || placeholder.length === 0) {
      throw new Error('add_dynamic_content: "placeholder" must be a non-empty string');
    }
    if (type !== 'CURRENT_TIME') {
      throw new Error('add_dynamic_content: only type "CURRENT_TIME" is supported in this PoC');
    }

    pages[path] = pages[path] || { content: '', dynamic: [] };
    pages[path].dynamic.push({ placeholder, type });
  },
  
  /**
   * set_layout({ header_html, footer_html })
   * Defines a shared header and footer applied to every page when serving.
   * The LLM should call this once per site (can be updated later if needed).
   */
  async set_layout(ctx, args) {
    const { header_html, footer_html } = args || {};
    const header = header_html != null ? String(header_html) : '';
    const footer = footer_html != null ? String(footer_html) : '';
    if (!ctx.layout) ctx.layout = { header_html: '', footer_html: '' };
    ctx.layout.header_html = header;
    ctx.layout.footer_html = footer;
  },
};

// OpenAI-compatible function tool definitions that we pass to the LLM API.
export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'create_page',
      description:
        'Create a page BODY at a specific URL path. Describe the body in plain English and the model will generate the HTML. Do NOT include shared header/footer — define those via set_layout(). You may include placeholders like {{CURRENT_TIME}} in the body.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The URL path to mount the page at, e.g., "/" or "/about".' },
          content: {
            type: 'string',
            description:
              'Plain-English description of the page BODY (unique content only). The model will generate the HTML. Placeholders like {{CURRENT_TIME}} can be marked with add_dynamic_content.',
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_dynamic_content',
      description:
        'Mark a placeholder in a page as dynamic so the framework replaces it at request time. Only CURRENT_TIME is supported.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The URL path of the page to modify.' },
          placeholder: { type: 'string', description: 'The exact placeholder text to replace, e.g., "{{CURRENT_TIME}}".' },
          type: { type: 'string', enum: ['CURRENT_TIME'], description: 'The dynamic type. Only CURRENT_TIME is supported.' },
        },
        required: ['path', 'placeholder', 'type'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_asset',
      description:
        'Insert an asset (e.g., an image) from the local assets/ directory into a page BODY. Describe intent in plain English; provide file name and placement. Use a placeholder when precise placement is needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The URL path of the page to modify.' },
          asset: { type: 'string', description: 'File name or relative path under assets/. For images, you can pass "test.png" or "images/test.png".' },
          alt: { type: 'string', description: 'Plain-English alt text for accessibility.' },
          placement: { type: 'string', enum: ['append', 'prepend', 'replace_placeholder'], description: 'Where to insert the asset. Default is append.' },
          placeholder: { type: 'string', description: 'If placement is replace_placeholder, the exact placeholder text to replace (e.g., "{{HERO_SECTION}}")' },
          className: { type: 'string', description: 'Optional CSS class name to apply to the element.' },
          width: { type: 'string', description: 'Optional width attribute (e.g., "600").' },
          height: { type: 'string', description: 'Optional height attribute (e.g., "400").' },
        },
        required: ['path', 'asset'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_layout',
      description:
        'Define a shared header and footer wrapper applied to all pages. Describe header/footer in plain English and the model will generate HTML fragments. Call once per site. Use create_page() for body content only.',
      parameters: {
        type: 'object',
        properties: {
          header_html: { type: 'string', description: 'HTML to prepend to every page (generated from a plain-English description; typically includes document declaration, head metadata, title, and opening body with navigation).' },
          footer_html: { type: 'string', description: 'HTML to append to every page (generated from a plain-English description; typically includes closing body and document end and any footer note).' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
];
