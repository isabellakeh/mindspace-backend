const axios = require('axios');
require('dotenv').config();

class NVIDIAService {
  constructor() {
    this.apiKey = process.env.NVIDIA_API_KEY;
    this.baseURL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
    this.isEnabled = process.env.ENABLE_AI_CHAT === 'true';
    
    this.models = {
      moderation: 'nvidia/nemo-guardrails',
      translation: 'meta/llama-3.1-70b-instruct',
      eventRecommendation: 'meta/llama-3.1-70b-instruct',
      calendarAnalysis: 'meta/llama-3.1-8b-instruct'
    };
  }

  async moderateForumContent(content, contentType = 'post') {
    if (!this.isEnabled || !this.apiKey) {
      return this.getFallbackModerationResult();
    }

    try {
      const response = await axios.post(`${this.baseURL}/chat/completions`, {
        model: this.models.moderation,
        messages: [{
          role: 'system',
          content: `You are a content moderator for a caregiver support forum for families with children with intellectual disabilities. 

Analyze the following ${contentType} for:
1. Harmful content (abuse, threats, harassment)
2. Inappropriate language (profanity, offensive terms)
3. Medical misinformation
4. Spam or promotional content
5. Off-topic content

Respond with a JSON object containing:
- "safe": true/false
- "flagged_categories": array of issues found
- "severity": "low", "medium", "high"
- "reason": brief explanation
- "suggested_action": "approve", "review", "reject"

Content to analyze:`
        }, {
          role: 'user',
          content: content
        }],
        temperature: 0.1,
        max_tokens: 300
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      const result = this.parseModerationResponse(response.data.choices[0].message.content);
      return {
        success: true,
        ...result,
        model: this.models.moderation
      };

    } catch (error) {
      console.error('Moderation error:', error.message);
      return this.getFallbackModerationResult();
    }
  }

  async translateForumPost(content, targetLanguage, sourceLanguage = 'auto') {
    if (!this.isEnabled || !this.apiKey) {
      return this.getFallbackTranslation(content, targetLanguage);
    }

    try {
      const response = await axios.post(`${this.baseURL}/chat/completions`, {
        model: this.models.translation,
        messages: [{
          role: 'system',
          content: `You are a professional translator specializing in caregiver and disability support content. 

Translate the following text to ${targetLanguage}. 
- Maintain the original tone and context
- Use appropriate terminology for disability and caregiving
- Preserve any medical or technical terms accuracy
- If the text contains sensitive content, translate with empathy

Respond with only the translated text, no additional commentary.`
        }, {
          role: 'user',
          content: content
        }],
        temperature: 0.3,
        max_tokens: 1000
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      });

      const translatedText = response.data.choices[0].message.content.trim();
      
      return {
        success: true,
        originalText: content,
        translatedText: translatedText,
        sourceLanguage: sourceLanguage,
        targetLanguage: targetLanguage,
        model: this.models.translation
      };

    } catch (error) {
      console.error('Translation error:', error.message);
      return this.getFallbackTranslation(content, targetLanguage);
    }
  }

  async recommendEvents(childProfile, availableEvents, preferences = {}) {
    if (!this.isEnabled || !this.apiKey) {
      return this.getFallbackEventRecommendations(availableEvents);
    }

    try {
      const response = await axios.post(`${this.baseURL}/chat/completions`, {
        model: this.models.eventRecommendation,
        messages: [{
          role: 'system',
          content: `You are an expert in recommending activities and events for children with intellectual disabilities.

Analyze the child profile and recommend the most suitable events from the available options.

Consider:
- Child's age, interests, and abilities
- Specific needs and accommodations
- Parent preferences and constraints
- Event accessibility and appropriateness
- Potential benefits for the child's development

Respond with a JSON array of recommended events, each containing:
- "event_id": the event ID
- "match_score": 0-100 (how well it matches)
- "reasons": array of reasons why it's recommended
- "considerations": any important notes for the parent
- "expected_benefits": potential positive outcomes

Limit to top 5 recommendations, ordered by match score.`
        }, {
          role: 'user',
          content: `Child Profile: ${JSON.stringify(childProfile)}

Available Events: ${JSON.stringify(availableEvents)}

Parent Preferences: ${JSON.stringify(preferences)}`
        }],
        temperature: 0.4,
        max_tokens: 1500
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000
      });

      const recommendations = this.parseEventRecommendations(response.data.choices[0].message.content);
      
      return {
        success: true,
        recommendations: recommendations,
        childId: childProfile.id,
        model: this.models.eventRecommendation
      };

    } catch (error) {
      console.error('Event recommendation error:', error.message);
      return this.getFallbackEventRecommendations(availableEvents);
    }
  }

  // ===============================
  // 4. CALENDAR ANALYSIS & BREAK RECOMMENDATIONS
  // ===============================
  
  async analyzeCalendarAndRecommendBreaks(calendarEvents, currentTime = new Date()) {
    if (!this.isEnabled || !this.apiKey) {
      return this.getFallbackBreakRecommendations();
    }

    try {
      const response = await axios.post(`${this.baseURL}/chat/completions`, {
        model: this.models.calendarAnalysis,
        messages: [{
          role: 'system',
          content: `You are a wellness coach specialized in caregiver mental health and stress management.

Analyze the user's calendar and recommend 5-minute micro-breaks based on:
- Gaps between appointments
- High-stress periods (back-to-back meetings)
- Meal times and natural break points
- Optimal timing for mental health
- Caregiver-specific stress patterns

Respond with a JSON object containing:
- "recommended_breaks": array of break suggestions
- "stress_analysis": assessment of calendar stress level (1-10)
- "optimal_times": best times for breaks today
- "warnings": any concerning patterns

Each break should include:
- "time": recommended time
- "duration": 5 minutes
- "activity": specific activity suggestion
- "reason": why this break is needed
- "type": "breathing", "movement", "mindfulness", "hydration", etc.`
        }, {
          role: 'user',
          content: `Current Time: ${currentTime.toISOString()}

Today's Calendar: ${JSON.stringify(calendarEvents)}`
        }],
        temperature: 0.5,
        max_tokens: 1000
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      });

      const analysis = this.parseCalendarAnalysis(response.data.choices[0].message.content);
      
      return {
        success: true,
        ...analysis,
        timestamp: currentTime,
        model: this.models.calendarAnalysis
      };

    } catch (error) {
      console.error('Calendar analysis error:', error.message);
      return this.getFallbackBreakRecommendations();
    }
  }

  // ===============================
  // RESPONSE PARSERS
  // ===============================
  
  parseModerationResponse(responseText) {
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error('Failed to parse moderation response:', e);
    }
    
    // Fallback parsing
    const safe = !responseText.toLowerCase().includes('unsafe') && 
                 !responseText.toLowerCase().includes('reject');
    
    return {
      safe: safe,
      flagged_categories: [],
      severity: safe ? 'low' : 'medium',
      reason: 'Unable to parse detailed analysis',
      suggested_action: safe ? 'approve' : 'review'
    };
  }
  
  parseEventRecommendations(responseText) {
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error('Failed to parse event recommendations:', e);
    }
    
    return [];
  }
  
  parseCalendarAnalysis(responseText) {
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error('Failed to parse calendar analysis:', e);
    }
    
    return {
      recommended_breaks: [],
      stress_analysis: 5,
      optimal_times: [],
      warnings: []
    };
  }

  // ===============================
  // FALLBACK RESPONSES
  // ===============================
  
  getFallbackModerationResult() {
    return {
      success: false,
      safe: true,
      flagged_categories: [],
      severity: 'low',
      reason: 'Moderation service unavailable - manual review recommended',
      suggested_action: 'review',
      model: 'fallback'
    };
  }
  
  getFallbackTranslation(content, targetLanguage) {
    return {
      success: false,
      originalText: content,
      translatedText: `[Translation to ${targetLanguage} unavailable - showing original text]`,
      sourceLanguage: 'unknown',
      targetLanguage: targetLanguage,
      model: 'fallback'
    };
  }
  
  getFallbackEventRecommendations(availableEvents) {
    // Return first 3 events as basic fallback
    const recommendations = availableEvents.slice(0, 3).map((event, index) => ({
      event_id: event.id,
      match_score: 70 - (index * 10),
      reasons: ['Event appears suitable for general participation'],
      considerations: ['Please review event details carefully'],
      expected_benefits: ['Social interaction', 'New experiences']
    }));
    
    return {
      success: false,
      recommendations: recommendations,
      model: 'fallback'
    };
  }
  
  getFallbackBreakRecommendations() {
    const now = new Date();
    const nextHour = new Date(now.getTime() + 60 * 60 * 1000);
    
    return {
      success: false,
      recommended_breaks: [{
        time: nextHour.toISOString(),
        duration: 5,
        activity: 'Take 5 deep breaths and stretch your shoulders',
        reason: 'Regular breaks help prevent caregiver burnout',
        type: 'breathing'
      }],
      stress_analysis: 5,
      optimal_times: [nextHour.toISOString()],
      warnings: ['AI analysis unavailable - please monitor your stress levels manually'],
      model: 'fallback'
    };
  }

  // ===============================
  // HEALTH CHECK
  // ===============================
  
  async healthCheck() {
    if (!this.isEnabled || !this.apiKey) {
      return {
        status: 'disabled',
        message: 'NVIDIA service is disabled or not configured'
      };
    }

    try {
      const response = await axios.get(`${this.baseURL}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 10000
      });

      return {
        status: 'healthy',
        models_available: Object.values(this.models),
        api_accessible: true
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        models_available: Object.values(this.models),
        api_accessible: false
      };
    }
  }
}

const nvidiaService = new NVIDIAService();
module.exports = { nvidiaService };