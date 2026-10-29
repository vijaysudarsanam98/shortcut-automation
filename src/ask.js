// Try the assistant locally without email:
//   npm run ask -- "what is Priya working on"
// Prints the plain-text answer and saves answer.html.
import { writeFile } from 'node:fs/promises';
import { requireShortcut } from './config.js';
import { answerQuestion } from './assistant.js';
import { runMain } from './run.js';

runMain(async () => {
  requireShortcut();
  const question = process.argv.slice(2).join(' ');
  const answer = await answerQuestion(question);
  console.log('\n' + answer.text + '\n');
  await writeFile('answer.html', answer.html);
  console.log('(Also saved as answer.html — open it in a browser to see the email version.)');
});
