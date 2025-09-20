// const axios = require('axios');
// require('dotenv').config();

// class NVIDIAService {
//   constructor() {
//     this.apiKey = process.env.NVIDIA_API_KEY;
//     this.baseURL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
//     this.model = process.env.AI_MODEL || 'meta/llama3-70b-instruct';
//     this.isEnabled = process.env.ENABLE_AI_CHAT === 'true';
//   }

//   async generateChatResponse(messages, userContext = {}) {
//     if (!this.isEnabled || !this.apiKey) {
//       return this.getFallbackResponse();
//     }

//     try {
//       const response = await axios.post(`${this.baseURL}/chat/completions`, {
//         model: this.model,
//         messages: this.formatMessages(messages, userContext),
//         temperature: 0.7,
//         max_tokens: 512,
//         stream: false
//       }, {
//         headers: {
//           'Authorization': `Bearer ${this.apiKey}`,
//           'Content-Type': 'application/json'
//         },
//         timeout: 30000
//       });

//       const aiResponse = response.data.choices[0].message.content;
      
//       return {
//         success: true,
//         response: aiResponse,
//         model: this.model,
//         usage: response.data.usage
//       };

//     } catch (error) {
//       console.error('NVIDIA API Error:', error.response?.data || error.message);
//       return this.getFallbackResponse();
//     }
//   }

//   formatMessages(messages, userContext) {
//     const systemPrompt = this.getSystemPrompt(userContext);
    
//     return [
//       { role: 'system', content: systemPrompt },
//       ...messages.slice(-10) // Keep last 10 messages for context
//     ];
//   }

//   getSystemPrompt(userContext) {
//     return `You are a compassionate AI assistant specifically designed to support caregivers of people with intellectual disabilities (PWIDs). 

// Your role is to:
// - Provide emotional support and validation
// - Offer practical caregiving advice and resources
// - Help identify signs of caregiver burnout and stress
// - Suggest self-care strategies and respite options
// - Connect caregivers with relevant resources and support groups

// Guidelines:
// - Always be empathetic, non-judgmental, and supportive
// - Recognize the unique challenges of PWID caregiving
// - Encourage professional help when needed
// - Maintain a warm, understanding tone
// - Focus on caregiver wellbeing and mental health

// Context about the user:
// ${userContext.caregiverRole ? `Role: ${userContext.caregiverRole}` : ''}
// ${userContext.experienceLevel ? `Experience: ${userContext.experienceLevel}` : ''}
// ${userContext.currentChallenges ? `Current challenges: ${userContext.currentChallenges}` : ''}

// Remember: You are not a replacement for professional medical or psychological care.`;
//   }

//   async analyzeSentiment(text) {
//     if (!this.isEnabled || !this.apiKey) {
//       return this.getBasicSentimentAnalysis(text);
//     }

//     try {
//       const response = await axios.post(`${this.baseURL}/chat/completions`, {
//         model: this.model,
//         messages: [{
//           role: 'system',
//           content: 'Analyze the sentiment of the following text. Respond with only: POSITIVE, NEGATIVE, NEUTRAL, or CRISIS (for urgent mental health concerns). Also provide a confidence score from 0-1.'
//         }, {
//           role: 'user',
//           content: text
//         }],
//         temperature: 0.3,
//         max_tokens: 50
//       }, {
//         headers: {
//           'Authorization': `Bearer ${this.apiKey}`,
//           'Content-Type': 'application/json'
//         },
//         timeout: 15000
//       });

//       const result = response.data.choices[0].message.content;
      
//       return {
//         success: true,
//         sentiment: this.parseSentimentResponse(result),
//         confidence: this.parseConfidenceScore(result)
//       };

//     } catch (error) {
//       console.error('Sentiment Analysis Error:', error);
//       return this.getBasicSentimentAnalysis(text);
//     }
//   }

//   getFallbackResponse() {
//     const fallbackResponses = [
//       "I'm here to support you through your caregiving journey. How are you feeling today?",
//       "Caregiving can be challenging. What's weighing on your mind right now?",
//       "You're doing important work as a caregiver. How can I support you today?",
//       "It's normal to feel overwhelmed sometimes. What would be most helpful to discuss?",
//       "Remember, taking care of yourself is just as important as caring for others. How are you doing?"
//     ];

//     return {
//       success: false,
//       response: fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)],
//       fallback: true,
//       model: 'fallback'
//     };
//   }

//   getBasicSentimentAnalysis(text) {
//     // Simple keyword-based sentiment analysis as fallback
//     const positiveWords = ['good', 'great', 'happy', 'better', 'improving', 'helpful', 'positive'];
//     const negativeWords = ['bad', 'terrible', 'sad', 'worse', 'difficult', 'struggling', 'overwhelmed'];
//     const crisisWords = ['suicide', 'kill myself', 'end it all', 'can\'t go on', 'give up'];
    
//     const lowerText = text.toLowerCase();
    
//     // Check for crisis indicators first
//     if (crisisWords.some(word => lowerText.includes(word))) {
//       return { success: true, sentiment: 'CRISIS', confidence: 0.9 };
//     }
    
//     const positiveScore = positiveWords.reduce((score, word) => 
//       score + (lowerText.includes(word) ? 1 : 0), 0);
//     const negativeScore = negativeWords.reduce((score, word) => 
//       score + (lowerText.includes(word) ? 1 : 0), 0);
    
//     if (positiveScore > negativeScore) {
//       return { success: true, sentiment: 'POSITIVE', confidence: 0.6 };
//     } else if (negativeScore > positiveScore) {
//       return { success: true, sentiment: 'NEGATIVE', confidence: 0.6 };
//     } else {
//       return { success: true, sentiment: 'NEUTRAL', confidence: 0.5 };
//     }
//   }

//   parseSentimentResponse(response) {
//     const sentiment = response.toUpperCase().match(/(POSITIVE|NEGATIVE|NEUTRAL|CRISIS)/);
//     return sentiment ? sentiment[0] : 'NEUTRAL';
//   }

//   parseConfidenceScore(response) {
//     const confidence = response.match(/(\d+\.?\d*)/);
//     return confidence ? parseFloat(confidence[0]) : 0.5;
//   }
// }

// // Export disabled service for now
// const nvidiaService = new NVIDIAService();
// */

// // TEMPORARY: Mock service while AI is disabled
// class MockNVIDIAService {
//   constructor() {
//     this.isEnabled = false;
//   }

//   async generateChatResponse(messages, userContext = {}) {
//     return {
//       success: false,
//       response: "AI chat is currently disabled. Our team is working to bring this feature back soon. In the meantime, please feel free to connect with other caregivers in the community or reach out to our support team.",
//       fallback: true,
//       model: 'disabled'
//     };
//   }

//   async analyzeSentiment(text) {
//     return {
//       success: false,
//       sentiment: 'NEUTRAL',
//       confidence: 0.5,
//       note: 'Sentiment analysis temporarily disabled'
//     };
//   }

//   getFallbackResponse() {
//     return {
//       success: false,
//       response: "AI support is temporarily unavailable. Please connect with our community or contact support for assistance.",
//       fallback: true,
//       model: 'disabled'
//     };
//   }
// }

// const nvidiaService = new MockNVIDIAService();

// module.exports = { nvidiaService };