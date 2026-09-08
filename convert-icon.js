const sharp = require('sharp');
const path = require('path');

async function convertIcon() {
  const inputPath = path.join(__dirname, 'build', 'icon.png');
  const outputPath = path.join(__dirname, 'build', 'icon_resized.png');

  // Force resize to 256x256
  await sharp(inputPath)
    .resize(256, 256, {
      fit: 'fill'
    })
    .png()
    .toFile(outputPath);

  // Replace original
  const fs = require('fs');
  fs.unlinkSync(inputPath);
  fs.renameSync(outputPath, inputPath);

  console.log('Icon resized to 256x256');
}

convertIcon().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
