// The site-wide entity graph, reproduced from production Rank Math output node
// for node, verified against /ai-governance/iso-42001/ on July 28, 2026.
//
// This lives in its own module because the site has TWO rendering paths and
// both must emit it:
//
//   - .astro pages render through BaseLayout
//   - the governance library renders through src/pages/ai-governance/[...slug].ts,
//     which builds HTML from templates/gov-*.tpl.html and never touches
//     BaseLayout
//
// Putting the graph only in BaseLayout is what caused the July 28 schema gate
// failure: all 67 governance URLs were missing Place, PostalAddress,
// GeoCoordinates, ImageObject, and WebSite, because BaseLayout was never in
// their render path at all. The migration's schema-parity gate requires the
// emitted @type set per URL to be a superset of production's, so both paths
// import from here.
//
// @id values are production's, so any downstream reference to
// srjconsultingservices.com/#organization and friends still resolves after
// cutover.

const SITE = 'https://srjconsultingservices.com';
const ORG_NAME = 'SRJ Consulting & Services LLC';
const LOGO = `${SITE}/wp-content/uploads/SRJ-Consulting-Services-Medium.jpg`;

/**
 * The four site-wide entity nodes. Identical on every URL.
 */
export function entityNodes(): object[] {
  return [
    {
      '@type': 'Organization',
      '@id': `${SITE}/#organization`,
      name: ORG_NAME,
      url: `${SITE}/`,
      logo: { '@id': `${SITE}/#logo` },
      image: { '@id': `${SITE}/#logo` },
      location: { '@id': `${SITE}/#place` },
      founder: { '@type': 'Person', name: 'Stephen R. Jordan', url: `${SITE}/about/` },
    },
    {
      '@type': 'Place',
      '@id': `${SITE}/#place`,
      geo: {
        '@type': 'GeoCoordinates',
        latitude: '33.189778366864',
        longitude: '-96.764620919976',
      },
      address: {
        '@type': 'PostalAddress',
        streetAddress: '13054 Cinderella Lane',
        addressLocality: 'Frisco',
        addressRegion: 'TX',
        postalCode: '75035',
        addressCountry: 'US',
      },
    },
    {
      '@type': 'ImageObject',
      '@id': `${SITE}/#logo`,
      url: LOGO,
      contentUrl: LOGO,
      caption: ORG_NAME,
      inLanguage: 'en-US',
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE}/#website`,
      url: `${SITE}/`,
      name: ORG_NAME,
      publisher: { '@id': `${SITE}/#organization` },
      inLanguage: 'en-US',
    },
  ];
}

/**
 * The per-URL WebPage node. Production emits one on every page, including the
 * governance hub, which previously had none on staging.
 */
export function webPageNode(url: string, name: string, description?: string | null): object {
  const node: any = {
    '@type': 'WebPage',
    '@id': url,
    url,
    name,
    isPartOf: { '@id': `${SITE}/#website` },
    about: { '@id': `${SITE}/#organization` },
    inLanguage: 'en-US',
  };
  // Production omits the property rather than emitting an empty one on the
  // pages that carry no meta description. Match that.
  if (description) node.description = description;
  return node;
}

/**
 * The full site-wide graph as a ready JSON-LD object.
 */
export function entityGraph(url: string, name: string, description?: string | null): object {
  return {
    '@context': 'https://schema.org',
    '@graph': [...entityNodes(), webPageNode(url, name, description)],
  };
}
