const axios = require('axios');
const util = require('util');

async function setWebhook() {
    const evoUrl = 'https://evolution-api-production-9d18.up.railway.app';
    const evoKey = 'f7387dc808f7ecedc23f7ee294592c06fd6833e72597d7f4100159c19f43d2e0';
    const botUrl = 'https://crm.scholarvault.in/webhook';

    try {
        console.log('Setting webhook to', botUrl);
        const res = await axios.post(`${evoUrl}/webhook/set/ScholarVault`, {
            webhook: {
                enabled: true,
                url: botUrl,
                byEvents: false,
                base64: true,
                events: [
                    "MESSAGES_UPSERT",
                    "SEND_MESSAGE",
                    "CONNECTION_UPDATE"
                ]
            }
        }, {
            headers: { apikey: evoKey }
        });
        console.log('Success!', res.data);
    } catch (e) {
        console.error('Error:', util.inspect(e.response ? e.response.data : e.message, {depth: null}));
    }
}

setWebhook();
