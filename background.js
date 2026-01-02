// ============================================
// AI Text Explainer - Background Service Worker
// ============================================

// Create context menu when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "explainText",
    title: "Explain this text with AI",
    contexts: ["selection"],
  });
});

// Listen for context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "explainText") {
    const selectedText = info.selectionText;

    // Validate text selection
    if (!selectedText || selectedText.trim().length === 0) {
      sendMessageToContent(tab.id, {
        type: "error",
        message: "Please select some text to explain.",
      });
      return;
    }

    // Get API configuration from storage
    chrome.storage.sync.get(
      ["apiKey", "apiProvider", "responseMode"],
      async (data) => {
        const { apiKey, apiProvider, responseMode } = data;

        // Check if API key is configured
        if (!apiKey) {
          sendMessageToContent(tab.id, {
            type: "error",
            message: "Please configure your API key in the extension settings.",
          });
          return;
        }

        // Send loading state to content script
        sendMessageToContent(tab.id, {
          type: "loading",
          text: selectedText,
        });

        // Call the appropriate AI API
        try {
          const explanation = await getAIExplanation(
            selectedText,
            apiKey,
            apiProvider || "openai",
            responseMode || "direct"
          );

          sendMessageToContent(tab.id, {
            type: "success",
            explanation: explanation,
            originalText: selectedText,
          });
        } catch (error) {
          sendMessageToContent(tab.id, {
            type: "error",
            message: error.message,
          });
        }
      }
    );
  }
});

/**
 * Send message to content script in the active tab
 * @param {number} tabId - The tab ID to send message to
 * @param {object} message - The message object to send
 */
async function sendMessageToContent(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // Content script may not be loaded yet, try injecting it first
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["content.js"],
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tabId },
        files: ["styles.css"],
      });
      // Retry sending the message after injection
      await chrome.tabs.sendMessage(tabId, message);
    } catch (injectionErr) {
      console.error("Failed to inject content script:", injectionErr);
    }
  }
}

/**
 * Get AI explanation from selected provider
 * @param {string} text - The text to explain
 * @param {string} apiKey - The API key
 * @param {string} provider - 'openai' or 'gemini'
 * @param {string} responseMode - 'explain' or 'direct'
 * @returns {Promise<string>} - The explanation
 */
async function getAIExplanation(text, apiKey, provider, responseMode) {
  if (provider === "openai") {
    return await getOpenAIExplanation(text, apiKey, responseMode);
  } else if (provider === "gemini") {
    return await getGeminiExplanation(text, apiKey, responseMode);
  } else {
    throw new Error("Invalid API provider selected");
  }
}

/**
 * Get explanation from OpenAI GPT API
 * @param {string} text - The text to explain
 * @param {string} apiKey - OpenAI API key
 * @param {string} responseMode - 'explain' or 'direct'
 * @returns {Promise<string>} - The explanation
 */
async function getOpenAIExplanation(text, apiKey, responseMode) {
  const endpoint = "https://api.openai.com/v1/chat/completions";

  const isDirectMode = responseMode === "direct";

  const systemPrompt = isDirectMode
    ? "You are a precision answerer. Given any question or text, respond with ONLY the final answer. No sentences, no explanations, no reasoning, no punctuation beyond the answer itself. If it's multiple choice, return just the exact option letter or text."
    : "You are a helpful assistant that explains text clearly and concisely. Provide explanations that are easy to understand, with context and examples when helpful.";

  const userPrompt = isDirectMode
    ? `Return ONLY the correct answer for this. Do not explain or add extra words.\n\n"${text}"`
    : `Please explain this text in a clear and concise way:\n\n"${text}"`;

  const requestBody = {
    model: "gpt-4-turbo",
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
    max_tokens: isDirectMode ? 60 : 500,
    temperature: isDirectMode ? 0 : 0.7,
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));

      if (response.status === 401) {
        throw new Error("Invalid OpenAI API key. Please check your settings.");
      } else if (response.status === 429) {
        throw new Error("OpenAI rate limit exceeded. Please try again later.");
      } else if (response.status === 500) {
        throw new Error("OpenAI server error. Please try again later.");
      } else {
        throw new Error(
          errorData.error?.message || `API error: ${response.status}`
        );
      }
    }

    const data = await response.json();

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error("Invalid response format from OpenAI");
    }

    return data.choices[0].message.content.trim();
  } catch (error) {
    if (error.message.includes("Failed to fetch")) {
      throw new Error("Network error. Please check your internet connection.");
    }
    throw error;
  }
}

/**
 * Get explanation from Google Gemini API
 * @param {string} text - The text to explain
 * @param {string} apiKey - Gemini API key
 * @param {string} responseMode - 'explain' or 'direct'
 * @returns {Promise<string>} - The explanation
 */
async function getGeminiExplanation(text, apiKey, responseMode) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const isDirectMode = responseMode === "direct";

  const prompt = isDirectMode
    ? `Return ONLY the correct answer. No sentences, no explanation, no extra words. If it's multiple choice, return just the option text or letter.\n\n"${text}"`
    : `Please explain this text in a clear and concise way:\n\n"${text}"`;

  const requestBody = {
    contents: [
      {
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: isDirectMode ? 0 : 0.7,
      maxOutputTokens: isDirectMode ? 60 : 500,
    },
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));

      if (response.status === 400) {
        throw new Error(
          "Invalid Gemini API key or request. Please check your settings."
        );
      } else if (response.status === 429) {
        throw new Error("Gemini rate limit exceeded. Please try again later.");
      } else if (response.status === 500) {
        throw new Error("Gemini server error. Please try again later.");
      } else {
        throw new Error(
          errorData.error?.message || `API error: ${response.status}`
        );
      }
    }

    const data = await response.json();

    if (
      !data.candidates ||
      !data.candidates[0] ||
      !data.candidates[0].content
    ) {
      throw new Error("Invalid response format from Gemini");
    }

    const content = data.candidates[0].content.parts[0].text;
    return content.trim();
  } catch (error) {
    if (error.message.includes("Failed to fetch")) {
      throw new Error("Network error. Please check your internet connection.");
    }
    throw error;
  }
}
