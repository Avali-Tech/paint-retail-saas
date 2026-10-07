// English messages for the business's logo and branded sign-in page (spread into en.ts):
// Settings → Appearance and the sign-in page.

export const brandingEn = {
  branding: {
    unknownLink:
      'This sign-in link doesn’t match any business. Check the link with your owner, or sign in below.',
    preferredBusiness: 'This sign-in page’s business',
    loading: 'Loading your logo and sign-in link…',
    logo: {
      title: 'Logo',
      description:
        'Shown in the header, on your sign-in page and as the browser tab’s icon. A PNG with a transparent background looks best; JPEG and WebP work too. Up to 1 MB.',
      none: 'No logo yet: the first letter of the app name shows instead.',
      previews: 'How the logo looks',
      onLight: 'On a light page',
      onDark: 'On a dark page',
      file: 'Logo file',
      fileHint: 'PNG, JPEG or WebP, 16 to 2048 pixels on each side',
      upload: 'Upload logo',
      remove: 'Remove logo',
      uploaded: 'Logo saved',
      removed: 'Logo removed',
      problems: {
        noFile: 'Choose a picture to upload',
        empty_file: 'This file is empty',
        file_type: 'This kind of file is not accepted. Upload a PNG, JPEG or WebP picture.',
        svg_not_allowed:
          'SVG logos are not accepted, because they can carry hidden scripts. Save the logo as a PNG (with a transparent background), JPEG or WebP.',
        too_large: 'This picture is larger than 1 MB. Save it smaller and try again.',
        dimensions: 'The picture must be 16 to 2048 pixels wide and high.',
        scanner_unavailable:
          'The virus scanner is off or not working, so the logo was not saved. Try again later.',
        storage_unavailable:
          'File storage is not set up on this server, so the logo was not saved.',
        virus_found: 'The file was refused: {detail}',
      },
    },
    link: {
      title: 'Sign-in link',
      description:
        'Your team signs in at this address and sees your name, logo and colours before signing in. Changing the name stops the old link from working.',
      slug: 'Link name',
      slugHint: 'Lower-case letters, digits and hyphens, e.g. sharma-paints',
      save: 'Save link name',
      saved: 'Sign-in link saved',
      address: 'Your sign-in link',
      copy: 'Copy link',
      copied: 'Link copied',
      copyFailed: 'Could not copy. Select the link and copy it.',
      problems: {
        length: 'Use 3 to 40 characters',
        format: 'Use lower-case letters, digits and single hyphens, not at the start or end',
        reserved: 'This name is reserved. Choose another.',
        taken: 'Another business uses this link name. Choose another.',
      },
    },
  },
};
