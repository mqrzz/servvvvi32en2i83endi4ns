const { checkAndPublishDueDrafts } = require('../routes/blog-cms');

async function runBlogAutoPublish() {
  try {
    await checkAndPublishDueDrafts();
  } catch (err) {
    console.error('runBlogAutoPublish:', err);
  }
}

module.exports = { runBlogAutoPublish };
