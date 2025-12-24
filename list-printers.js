require('dotenv').config();
const fetch = require('node-fetch');

const API_KEY = process.env.PRINTNODE_API_KEY;

async function listPrinters() {
  console.log('🖨️  Fetching printers from PrintNode...\n');

  try {
    // First, get account info
    const whoami = await fetch('https://api.printnode.com/whoami', {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(API_KEY + ':').toString('base64')
      }
    });
    
    if (!whoami.ok) {
      throw new Error(`Auth failed: ${whoami.status}`);
    }
    
    const account = await whoami.json();
    console.log(`✅ Connected as: ${account.firstname} ${account.lastname}`);
    console.log(`   Email: ${account.email}\n`);

    // Get computers
    const computersRes = await fetch('https://api.printnode.com/computers', {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(API_KEY + ':').toString('base64')
      }
    });
    
    const computers = await computersRes.json();
    console.log(`📍 Found ${computers.length} computer(s):\n`);

    // Get printers
    const printersRes = await fetch('https://api.printnode.com/printers', {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(API_KEY + ':').toString('base64')
      }
    });
    
    const printers = await printersRes.json();

    for (const computer of computers) {
      console.log(`   💻 ${computer.name} (ID: ${computer.id})`);
      console.log(`      State: ${computer.state}`);
      
      const computerPrinters = printers.filter(p => p.computer.id === computer.id);
      
      if (computerPrinters.length === 0) {
        console.log('      No printers\n');
      } else {
        console.log('      Printers:');
        for (const printer of computerPrinters) {
          console.log(`\n         🖨️  ${printer.name}`);
          console.log(`            ID: ${printer.id}  ← Use this in .env`);
          console.log(`            State: ${printer.state}`);
          console.log(`            Default: ${printer.default ? 'Yes' : 'No'}`);
        }
        console.log('');
      }
    }

    console.log('\n📝 Add to your .env file:');
    console.log('   PRINTNODE_INVOICE_PRINTER_ID=<printer_id>');
    console.log('   PRINTNODE_GIFTCARD_PRINTER_ID=<printer_id>');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

listPrinters();
