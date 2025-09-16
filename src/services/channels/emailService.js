import nodemailer from 'nodemailer';
import { EventEmitter } from 'events';
import NotificationUser from '../../models/User.js';
import DeviceToken from '../../models/DeviceToken.js';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import handlebars from 'handlebars';

// Event emitter for email events
export const emailEvents = new EventEmitter();

// Email service configuration
const EMAIL_CONFIG = {
  // Multiple provider support
  providers: {
    gmail: {
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
      }
    },
    sendgrid: {
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: {
        user: 'apikey',
        pass: process.env.SENDGRID_API_KEY
      }
    },
    ses: {
      host: process.env.SES_HOST || 'email-smtp.us-east-1.amazonaws.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.SES_ACCESS_KEY,
        pass: process.env.SES_SECRET_KEY
      }
    },
    mailgun: {
      host: 'smtp.mailgun.org',
      port: 587,
      secure: false,
      auth: {
        user: process.env.MAILGUN_SMTP_USER,
        pass: process.env.MAILGUN_SMTP_PASS
      }
    },
    custom: {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    }
  },
  
  // Default settings
  defaults: {
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'lovebhumi999@gmail.com',
    replyTo: process.env.EMAIL_REPLY_TO,
    maxRetries: 3,
    retryDelay: 5000, // 5 seconds
    timeout: 30000, // 30 seconds
    rateLimit: 100, // emails per minute
    batchSize: 50 // max emails per batch
  }
};

// Email template cache
const templateCache = new Map();

// Rate limiting
const emailRateLimit = {
  count: 0,
  resetTime: Date.now() + 60000, // 1 minute
  isLimited: false
};

class EmailService {
  constructor() {
    this.transporter = null;
    this.provider = null;
    this.isInitialized = false;
    this.fallbackProviders = [];
    this.templates = new Map();
    this.metrics = {
      sent: 0,
      delivered: 0,
      failed: 0,
      bounced: 0,
      opened: 0,
      clicked: 0
    };
    
    this.initialize();
  }
  
  // Initialize email service with multiple providers
  async initialize() {
    try {
      // Determine primary provider
      this.provider = this.detectProvider();
      
      if (!this.provider) {
        console.warn('No email provider configured. Email service disabled.');
        return;
      }
      
      // Create transporter
      this.transporter = await this.createTransporter(this.provider);
      
      // Setup fallback providers
      this.setupFallbackProviders();
      
      // Load email templates
      await this.loadTemplates();
      
      // Verify transporter
      await this.verifyTransporter();
      
      this.isInitialized = true;
      console.log(`Email service initialized with provider: ${this.provider}`);
      
      // Setup monitoring
      this.setupMonitoring();
      
    } catch (error) {
      console.error('Failed to initialize email service:', error);
      this.isInitialized = false;
    }
  }
  
  // Detect available email provider
  detectProvider() {
    const providers = Object.keys(EMAIL_CONFIG.providers);
    
    for (const provider of providers) {
      const config = EMAIL_CONFIG.providers[provider];
      
      if (provider === 'gmail' && config.auth.user && config.auth.pass) {
        return 'gmail';
      } else if (provider === 'sendgrid' && config.auth.pass) {
        return 'sendgrid';
      } else if (provider === 'ses' && config.auth.user && config.auth.pass) {
        return 'ses';
      } else if (provider === 'mailgun' && config.auth.user && config.auth.pass) {
        return 'mailgun';
      } else if (provider === 'custom' && config.host && config.auth.user && config.auth.pass) {
        return 'custom';
      }
    }
    
    return null;
  }
  
  // Create nodemailer transporter
  async createTransporter(providerName) {
    const config = EMAIL_CONFIG.providers[providerName];
    
    const transporterConfig = {
      ...config,
      pool: true, // Use connection pooling
      maxConnections: 5,
      maxMessages: 100,
      rateDelta: 1000, // 1 second
      rateLimit: EMAIL_CONFIG.defaults.rateLimit,
      socketTimeout: EMAIL_CONFIG.defaults.timeout,
      connectionTimeout: EMAIL_CONFIG.defaults.timeout
    };
    
    const transporter = nodemailer.createTransport(transporterConfig);
    
    // Add event listeners
    this.setupTransporterEvents(transporter, providerName);
    
    return transporter;
  }
  
  // Setup transporter event listeners
  setupTransporterEvents(transporter, providerName) {
    transporter.on('idle', () => {
      console.debug(`Email transporter (${providerName}) is idle`);
    });
    
    transporter.on('error', (error) => {
      console.error(`Email transporter (${providerName}) error:`, error);
      emailEvents.emit('transporter:error', { provider: providerName, error });
    });
  }
  
  // Setup fallback providers
  setupFallbackProviders() {
    const providers = Object.keys(EMAIL_CONFIG.providers).filter(p => p !== this.provider);
    
    for (const provider of providers) {
      const config = EMAIL_CONFIG.providers[provider];
      if (this.isProviderConfigValid(provider, config)) {
        this.fallbackProviders.push(provider);
      }
    }
    
    console.log(`Fallback providers configured: ${this.fallbackProviders.join(', ')}`);
  }
  
  // Check if provider config is valid
  isProviderConfigValid(provider, config) {
    switch (provider) {
      case 'gmail':
        return config.auth.user && config.auth.pass;
      case 'sendgrid':
        return config.auth.pass;
      case 'ses':
        return config.auth.user && config.auth.pass;
      case 'mailgun':
        return config.auth.user && config.auth.pass;
      case 'custom':
        return config.host && config.auth.user && config.auth.pass;
      default:
        return false;
    }
  }
  
  // Verify transporter connection
  async verifyTransporter() {
    if (!this.transporter) return false;
    
    try {
      await this.transporter.verify();
      console.log(`Email transporter verified successfully (${this.provider})`);
      return true;
    } catch (error) {
      console.error(`Email transporter verification failed (${this.provider}):`, error);
      throw error;
    }
  }
  
  // Load email templates
  async loadTemplates() {
    try {
      const templatesDir = path.join(process.cwd(), 'templates', 'email');
      
      // Check if templates directory exists
      try {
        await fs.access(templatesDir);
      } catch {
        console.warn('Email templates directory not found, using inline templates');
        this.loadInlineTemplates();
        return;
      }
      
      // Load template files
      const templateFiles = await fs.readdir(templatesDir);
      
      for (const file of templateFiles) {
        if (file.endsWith('.hbs') || file.endsWith('.html')) {
          const templateName = path.basename(file, path.extname(file));
          const templatePath = path.join(templatesDir, file);
          const templateContent = await fs.readFile(templatePath, 'utf8');
          
          // Compile handlebars template
          const compiledTemplate = handlebars.compile(templateContent);
          this.templates.set(templateName, compiledTemplate);
          
          console.debug(`Loaded email template: ${templateName}`);
        }
      }
      
      console.log(`Loaded ${this.templates.size} email templates`);
      
    } catch (error) {
      console.error('Failed to load email templates:', error);
      this.loadInlineTemplates();
    }
  }
  
  // Load inline templates as fallback
  loadInlineTemplates() {
    const inlineTemplates = {
      default: handlebars.compile(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>{{title}}</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #007bff; color: white; padding: 20px; text-align: center; }
            .content { padding: 20px; background: #f9f9f9; }
            .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
            .button { display: inline-block; padding: 12px 24px; background: #007bff; color: white; text-decoration: none; border-radius: 4px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>{{title}}</h1>
            </div>
            <div class="content">
              <p>{{body}}</p>
              {{#if actions}}
                {{#each actions}}
                  <a href="{{url}}" class="button">{{label}}</a>
                {{/each}}
              {{/if}}
            </div>
            <div class="footer">
              <p>© 2024 Throne8. All rights reserved.</p>
              {{#if unsubscribeUrl}}
                <p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>
              {{/if}}
            </div>
          </div>
        </body>
        </html>
      `),
      
      welcome: handlebars.compile(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Welcome to Throne8!</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .welcome-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { padding: 30px; background: white; border: 1px solid #e1e5e9; }
            .cta-button { display: inline-block; padding: 15px 30px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: bold; }
            .features { margin: 20px 0; }
            .feature { margin: 10px 0; padding: 15px; background: #f8f9fa; border-left: 4px solid #007bff; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="welcome-header">
              <h1>Welcome to Throne8, {{userName}}! 🎉</h1>
              <p>Your journey to greatness starts here</p>
            </div>
            <div class="content">
              <p>Hi {{userName}},</p>
              <p>Welcome to Throne8! We're thrilled to have you join our community of achievers.</p>
              
              <div class="features">
                <div class="feature">
                  <strong>🚀 Get Started:</strong> Complete your profile to unlock all features
                </div>
                <div class="feature">
                  <strong>🏆 Achievements:</strong> Track your progress and earn rewards
                </div>
                <div class="feature">
                  <strong>👥 Community:</strong> Connect with like-minded individuals
                </div>
              </div>
              
              <center>
                <a href="{{setupUrl}}" class="cta-button">Complete Your Setup</a>
              </center>
              
              <p>If you have any questions, feel free to reach out to our support team.</p>
              <p>Best regards,<br>The Throne8 Team</p>
            </div>
          </div>
        </body>
        </html>
      `),
      
      notification: handlebars.compile(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>{{title}}</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; }
            .header { background: #007bff; color: white; padding: 20px; text-align: center; }
            .content { padding: 20px; background: white; }
            .notification-body { font-size: 16px; margin: 20px 0; }
            .actions { margin: 20px 0; }
            .action-button { display: inline-block; padding: 12px 24px; margin: 5px; text-decoration: none; border-radius: 4px; font-weight: bold; }
            .primary { background: #007bff; color: white; }
            .secondary { background: #6c757d; color: white; }
            .footer { padding: 20px; background: #f8f9fa; text-align: center; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>{{title}}</h2>
            </div>
            <div class="content">
              <div class="notification-body">
                {{body}}
              </div>
              {{#if actions}}
                <div class="actions">
                  {{#each actions}}
                    <a href="{{url}}" class="action-button {{#if @first}}primary{{else}}secondary{{/if}}">{{label}}</a>
                  {{/each}}
                </div>
              {{/if}}
              {{#if metadata}}
                <p><small>{{metadata}}</small></p>
              {{/if}}
            </div>
            <div class="footer">
              <p>© 2024 Throne8. All rights reserved.</p>
              {{#if unsubscribeUrl}}
                <p><a href="{{unsubscribeUrl}}">Unsubscribe from these notifications</a></p>
              {{/if}}
            </div>
          </div>
        </body>
        </html>
      `)
    };
    
    Object.entries(inlineTemplates).forEach(([name, template]) => {
      this.templates.set(name, template);
    });
    
    console.log('Loaded inline email templates');
  }
  
  // Setup monitoring and metrics
  setupMonitoring() {
    // Reset rate limit counter every minute
    setInterval(() => {
      emailRateLimit.count = 0;
      emailRateLimit.resetTime = Date.now() + 60000;
      emailRateLimit.isLimited = false;
    }, 60000);
    
    // Log metrics every hour
    setInterval(() => {
      console.log('Email service metrics:', this.metrics);
      emailEvents.emit('metrics:hourly', { ...this.metrics });
    }, 3600000); // 1 hour
  }
  
  // Check rate limit
  checkRateLimit() {
    if (Date.now() > emailRateLimit.resetTime) {
      emailRateLimit.count = 0;
      emailRateLimit.resetTime = Date.now() + 60000;
      emailRateLimit.isLimited = false;
    }
    
    if (emailRateLimit.count >= EMAIL_CONFIG.defaults.rateLimit) {
      emailRateLimit.isLimited = true;
      return false;
    }
    
    return true;
  }
  
  // Get email template
  getTemplate(templateName) {
    // Try specific template first
    if (this.templates.has(templateName)) {
      return this.templates.get(templateName);
    }
    
    // Fall back to notification template
    if (this.templates.has('notification')) {
      return this.templates.get('notification');
    }
    
    // Final fallback to default template
    return this.templates.get('default');
  }
  
  // Generate tracking URLs
  generateTrackingUrls(notificationId, userId) {
    const baseUrl = process.env.APP_URL || 'https://throne8.com';
    const trackingToken = crypto.createHash('sha256')
      .update(`${notificationId}-${userId}-${process.env.TRACKING_SECRET || 'secret'}`)
      .digest('hex').substring(0, 32);
    
    return {
      open: `${baseUrl}/api/tracking/email/open?t=${trackingToken}&n=${notificationId}`,
      click: `${baseUrl}/api/tracking/email/click?t=${trackingToken}&n=${notificationId}`,
      unsubscribe: `${baseUrl}/api/notifications/unsubscribe?t=${trackingToken}&u=${userId}`
    };
  }
  
  // Main send function
  async send(userId, payload, options = {}) {
    if (!this.isInitialized || !this.transporter) {
      console.warn('Email service not initialized or no transporter available');
      return { success: false, error: 'Email service not available' };
    }
    
    try {
      // Check rate limit
      if (!this.checkRateLimit()) {
        console.warn('Email rate limit exceeded');
        return { success: false, error: 'Rate limit exceeded' };
      }
      
      // Get user data
      const user = await this.getUserData(userId);
      if (!user || !user.contact?.email) {
        return { success: false, error: 'User email not found' };
      }
      
      // Check if user can receive emails
      if (!user.canReceiveNotification(payload.type || 'general', 'email', payload.priority || 'medium')) {
        return { success: false, error: 'User preferences block email notifications' };
      }
      
      // Prepare email data
      const emailData = await this.prepareEmailData(user, payload, options);
      
      // Send email
      const result = await this.sendEmail(emailData, options);
      
      // Update metrics
      if (result.success) {
        this.metrics.sent++;
        emailRateLimit.count++;
        
        // Update user metrics
        await user.recordNotificationReceived('email');
      } else {
        this.metrics.failed++;
      }
      
      // Emit event
      emailEvents.emit('email:sent', {
        userId,
        success: result.success,
        provider: this.provider,
        messageId: result.messageId,
        error: result.error
      });
      
      return result;
      
    } catch (error) {
      console.error('Email send error:', error);
      this.metrics.failed++;
      
      emailEvents.emit('email:error', {
        userId,
        error: error.message,
        provider: this.provider
      });
      
      return { success: false, error: error.message };
    }
  }
  
  // Get user data
  async getUserData(userId) {
    try {
      // Try to get from NotificationUser first
      let user = await NotificationUser.findOne({ userId });
      
      if (!user) {
        // Fallback: create minimal user record
        user = new NotificationUser({
          userId,
          contact: { email: 'bhumi.lalwani.0911@gmail.com' },
          preferences: { enabled: true }
        });
      }
      
      return user;
    } catch (error) {
      console.error('Error getting user data:', error);
      return null;
    }
  }
  
  // Prepare email data
  async prepareEmailData(user, payload, options) {
    const {
      template = 'default',
      subject,
      tracking = true,
      priority = 'normal'
    } = options;
    
    // Generate tracking URLs if enabled
    const trackingUrls = tracking && payload.notificationId 
      ? this.generateTrackingUrls(payload.notificationId, user.userId)
      : null;
    
    // Prepare template data
    const templateData = {
      userName: user.profile?.displayName || user.profile?.firstName || 'User',
      userEmail: user.contact.email,
      title: payload.title,
      body: payload.body,
      actions: payload.actions?.map(action => ({
        ...action,
        url: tracking ? `${trackingUrls.click}&redirect=${encodeURIComponent(action.url || '#')}` : action.url
      })),
      metadata: payload.metadata,
      unsubscribeUrl: trackingUrls?.unsubscribe,
      appName: 'Throne8',
      appUrl: process.env.APP_URL || 'https://throne8.com',
      currentYear: new Date().getFullYear(),
      ...payload.variables
    };
    
    // Get and compile template
    const templateFunction = this.getTemplate(template);
    const htmlContent = templateFunction(templateData);
    
    // Prepare email object
    const emailData = {
      from: {
        name: payload.fromName || 'Throne8',
        address: EMAIL_CONFIG.defaults.from
      },
      to: {
        name: templateData.userName,
        address: user.contact.email
      },
      subject: subject || payload.title,
      html: htmlContent,
      text: this.generateTextVersion(payload),
      messageId: this.generateMessageId(),
      headers: {
        'X-Notification-ID': payload.notificationId,
        'X-User-ID': user.userId,
        'X-Priority': priority,
        'X-Mailer': 'Throne8-Notification-Service'
      }
    };
    
    // Add tracking pixel if enabled
    if (tracking && trackingUrls) {
      emailData.html += `<img src="${trackingUrls.open}" width="1" height="1" style="display:none;" alt="">`;
    }
    
    // Add reply-to if specified
    if (EMAIL_CONFIG.defaults.replyTo) {
      emailData.replyTo = EMAIL_CONFIG.defaults.replyTo;
    }
    
    // Add attachments if any
    if (payload.attachments) {
      emailData.attachments = payload.attachments;
    }
    
    return emailData;
  }
  
  // Generate text version of email
  generateTextVersion(payload) {
    let text = `${payload.title}\n\n`;
    text += `${payload.body}\n\n`;
    
    if (payload.actions && payload.actions.length > 0) {
      text += 'Actions:\n';
      payload.actions.forEach(action => {
        text += `- ${action.label}: ${action.url || 'N/A'}\n`;
      });
      text += '\n';
    }
    
    text += '---\n';
    text += 'This email was sent by Throne8 Notification Service.\n';
    text += 'If you don\'t want to receive these emails, you can unsubscribe.';
    
    return text;
  }
  
  // Generate unique message ID
  generateMessageId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString('hex');
    const domain = EMAIL_CONFIG.defaults.from.split('@')[1] || 'throne8.com';
    return `<${timestamp}.${random}@${domain}>`;
  }
  
  // Send email with retry logic
  async sendEmail(emailData, options = {}) {
    const maxRetries = options.maxRetries || EMAIL_CONFIG.defaults.maxRetries;
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const info = await this.transporter.sendMail(emailData);
        
        return {
          success: true,
          messageId: info.messageId,
          response: info.response,
          provider: this.provider,
          attempt
        };
        
      } catch (error) {
        lastError = error;
        console.error(`Email send attempt ${attempt}/${maxRetries} failed:`, error.message);
        
        // Try fallback provider on last attempt
        if (attempt === maxRetries && this.fallbackProviders.length > 0) {
          try {
            const fallbackResult = await this.tryFallbackProvider(emailData);
            if (fallbackResult.success) {
              return fallbackResult;
            }
          } catch (fallbackError) {
            console.error('Fallback provider also failed:', fallbackError.message);
          }
        }
        
        // Wait before retry (exponential backoff)
        if (attempt < maxRetries) {
          const delay = EMAIL_CONFIG.defaults.retryDelay * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    return {
      success: false,
      error: lastError.message,
      code: lastError.code,
      provider: this.provider,
      attempts: maxRetries
    };
  }
  
  // Try fallback email provider
  async tryFallbackProvider(emailData) {
    for (const providerName of this.fallbackProviders) {
      try {
        console.log(`Trying fallback provider: ${providerName}`);
        
        const fallbackTransporter = await this.createTransporter(providerName);
        await fallbackTransporter.verify();
        
        const info = await fallbackTransporter.sendMail(emailData);
        
        console.log(`Fallback provider ${providerName} succeeded`);
        
        return {
          success: true,
          messageId: info.messageId,
          response: info.response,
          provider: providerName,
          fallback: true
        };
        
      } catch (error) {
        console.error(`Fallback provider ${providerName} failed:`, error.message);
        continue;
      }
    }
    
    throw new Error('All fallback providers failed');
  }
  
  // Send bulk emails
  async sendBulk(emailList, options = {}) {
    if (!this.isInitialized) {
      return { success: false, error: 'Email service not initialized' };
    }
    
    const { batchSize = EMAIL_CONFIG.defaults.batchSize } = options;
    const results = [];
    const errors = [];
    
    // Process emails in batches
    for (let i = 0; i < emailList.length; i += batchSize) {
      const batch = emailList.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (emailItem) => {
        try {
          const result = await this.send(emailItem.userId, emailItem.payload, emailItem.options);
          return { success: true, userId: emailItem.userId, result };
        } catch (error) {
          return { success: false, userId: emailItem.userId, error: error.message };
        }
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach(result => {
        if (result.status === 'fulfilled') {
          if (result.value.success) {
            results.push(result.value);
          } else {
            errors.push(result.value);
          }
        } else {
          errors.push({ success: false, error: result.reason.message });
        }
      });
      
      // Rate limiting between batches
      if (i + batchSize < emailList.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return {
      success: true,
      total: emailList.length,
      sent: results.length,
      failed: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  // Webhook handler for delivery status updates
  async handleDeliveryWebhook(provider, payload) {
    try {
      let notificationId, status, error;
      
      // Parse different provider webhooks
      switch (provider) {
        case 'sendgrid':
          notificationId = payload.sg_message_id;
          status = this.mapSendGridStatus(payload.event);
          error = payload.reason;
          break;
          
        case 'mailgun':
          notificationId = payload['message-id'];
          status = this.mapMailgunStatus(payload.event);
          error = payload.reason;
          break;
          
        case 'ses':
          // SES SNS notification
          if (payload.Type === 'Notification') {
            const message = JSON.parse(payload.Message);
            notificationId = message.mail?.messageId;
            status = this.mapSESStatus(message.eventType);
            error = message.bounce?.reason || message.complaint?.reason;
          }
          break;
          
        default:
          console.warn(`Unknown email provider webhook: ${provider}`);
          return { success: false, error: 'Unknown provider' };
      }
      
      if (notificationId && status) {
        // Update notification delivery status
        emailEvents.emit('delivery:update', {
          messageId: notificationId,
          status,
          error,
          provider,
          timestamp: new Date()
        });
        
        // Update metrics
        switch (status) {
          case 'delivered':
            this.metrics.delivered++;
            break;
          case 'bounced':
            this.metrics.bounced++;
            break;
          case 'opened':
            this.metrics.opened++;
            break;
          case 'clicked':
            this.metrics.clicked++;
            break;
        }
        
        return { success: true, status, messageId: notificationId };
      }
      
      return { success: false, error: 'Invalid webhook payload' };
      
    } catch (error) {
      console.error('Email webhook processing error:', error);
      return { success: false, error: error.message };
    }
  }
  
  // Map SendGrid status to standard status
  mapSendGridStatus(event) {
    const statusMap = {
      'delivered': 'delivered',
      'bounce': 'bounced',
      'dropped': 'failed',
      'deferred': 'deferred',
      'processed': 'sent',
      'open': 'opened',
      'click': 'clicked',
      'spamreport': 'spam',
      'unsubscribe': 'unsubscribed',
      'group_unsubscribe': 'unsubscribed'
    };
    
    return statusMap[event] || 'unknown';
  }
  
  // Map Mailgun status to standard status
  mapMailgunStatus(event) {
    const statusMap = {
      'delivered': 'delivered',
      'failed': 'failed',
      'bounced': 'bounced',
      'dropped': 'failed',
      'accepted': 'sent',
      'rejected': 'failed',
      'opened': 'opened',
      'clicked': 'clicked',
      'unsubscribed': 'unsubscribed',
      'complained': 'spam'
    };
    
    return statusMap[event] || 'unknown';
  }
  
  // Map AWS SES status to standard status
  mapSESStatus(eventType) {
    const statusMap = {
      'send': 'sent',
      'delivery': 'delivered',
      'bounce': 'bounced',
      'complaint': 'spam',
      'reject': 'failed',
      'open': 'opened',
      'click': 'clicked'
    };
    
    return statusMap[eventType] || 'unknown';
  }
  
  // Test email functionality
  async testEmail(testEmail = 'test@example.com') {
    if (!this.isInitialized) {
      return { success: false, error: 'Email service not initialized' };
    }
    
    try {
      const testPayload = {
        title: 'Email Service Test',
        body: 'This is a test email from Throne8 notification service.',
        type: 'system',
        priority: 'low',
        variables: {
          testMode: true,
          timestamp: new Date().toISOString()
        }
      };
      
      const testOptions = {
        template: 'notification',
        subject: 'Test Email - Throne8 Notification Service',
        tracking: false
      };
      
      // Create temporary user for testing
  const testUser = new NotificationUser({
  userId: 'test-user',
  contact: { email: testEmail },
  profile: { displayName: 'Test User' },
  status: { isActive: true, isPaused: false },
  notificationPreferences: [{ type: 'general', channels: ['email'], enabled: true, frequency: 'immediate', priority: 'medium' }],
  quietHours: { enabled: false },
  consents: []
});
await sendEmailToUser(testUser, payload);

      const emailData = await this.prepareEmailData(testUser, testPayload, testOptions);
      const result = await this.sendEmail(emailData, testOptions);
      
      return {
        success: result.success,
        provider: this.provider,
        messageId: result.messageId,
        testEmail,
        timestamp: new Date()
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        provider: this.provider,
        testEmail
      };
    }
  }
  
  // Get service health status
  getHealthStatus() {
    const totalEmails = this.metrics.sent + this.metrics.failed;
    const successRate = totalEmails > 0 ? (this.metrics.sent / totalEmails) * 100 : 100;
    
    return {
      status: this.isInitialized ? 'healthy' : 'unhealthy',
      provider: this.provider,
      fallbackProviders: this.fallbackProviders,
      metrics: { ...this.metrics },
      successRate: Math.round(successRate * 100) / 100,
      rateLimit: {
        current: emailRateLimit.count,
        limit: EMAIL_CONFIG.defaults.rateLimit,
        resetTime: emailRateLimit.resetTime
      },
      templates: Array.from(this.templates.keys()),
      isInitialized: this.isInitialized
    };
  }
  
  // Reset metrics
  resetMetrics() {
    this.metrics = {
      sent: 0,
      delivered: 0,
      failed: 0,
      bounced: 0,
      opened: 0,
      clicked: 0
    };
  }
  
  // Shutdown gracefully
  async shutdown() {
    if (this.transporter) {
      this.transporter.close();
      console.log('Email service transporter closed');
    }
    
    this.isInitialized = false;
    console.log('Email service shutdown complete');
  }
}

// Create singleton instance
const emailService = new EmailService();

// Handle process shutdown
process.on('SIGTERM', () => {
  emailService.shutdown();
});

process.on('SIGINT', () => {
  emailService.shutdown();
});

// Email tracking endpoints (for webhook integration)
export const trackEmailOpen = async (req, res, next) => {
  try {
    const { t: token, n: notificationId } = req.query;
    
    if (!token || !notificationId) {
      return res.status(400).send('Invalid tracking parameters');
    }
    
    // Verify tracking token
    // const isValid = verifyTrackingToken(token, notificationId);
    // if (!isValid) {
    //   return res.status(401).send('Invalid tracking token');
    // }
    
    // Update notification metrics
    emailEvents.emit('email:opened', {
      notificationId,
      timestamp: new Date(),
      userAgent: req.get('User-Agent'),
      ipAddress: req.ip
    });
    
    // Return 1x1 transparent pixel
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    );
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': pixel.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    res.send(pixel);
    
  } catch (error) {
    console.error('Email tracking error:', error);
    res.status(500).send('Tracking error');
  }
};

export const trackEmailClick = async (req, res, next) => {
  try {
    const { t: token, n: notificationId, redirect } = req.query;
    
    if (!token || !notificationId) {
      return res.status(400).send('Invalid tracking parameters');
    }
    
    // Update notification metrics
    emailEvents.emit('email:clicked', {
      notificationId,
      redirectUrl: redirect,
      timestamp: new Date(),
      userAgent: req.get('User-Agent'),
      ipAddress: req.ip
    });
    
    // Redirect to target URL
    if (redirect) {
      res.redirect(302, decodeURIComponent(redirect));
    } else {
      res.status(200).send('Click tracked');
    }
    
  } catch (error) {
    console.error('Email click tracking error:', error);
    res.status(500).send('Tracking error');
  }
};

// Enhanced email service with additional methods
class EnhancedEmailService extends EmailService {
  
  // Send transactional email
  async sendTransactional(userId, template, data, options = {}) {
    const payload = {
      title: data.subject || data.title,
      body: data.message || data.body,
      type: 'system',
      priority: 'high',
      variables: data,
      notificationId: options.notificationId
    };
    
    return this.send(userId, payload, {
      ...options,
      template,
      tracking: options.tracking !== false
    });
  }
  
  // Send welcome email
  async sendWelcomeEmail(userId, userData = {}) {
    const payload = {
      title: `Welcome to Throne8, ${userData.name || 'User'}!`,
      body: 'Thanks for joining our community. Let\'s get you started!',
      type: 'system',
      priority: 'medium',
      variables: {
        userName: userData.name,
        setupUrl: `${process.env.APP_URL}/setup`,
        ...userData
      },
      actions: [
        {
          id: 'complete_setup',
          label: 'Complete Setup',
          url: `${process.env.APP_URL}/setup`
        }
      ]
    };
    
    return this.send(userId, payload, {
      template: 'welcome',
      subject: `Welcome to Throne8, ${userData.name || 'User'}!`
    });
  }
  
  // Send password reset email
  async sendPasswordReset(userId, resetData) {
    const payload = {
      title: 'Password Reset Request',
      body: 'You requested a password reset. Click the link below to reset your password.',
      type: 'security',
      priority: 'high',
      variables: {
        resetUrl: resetData.resetUrl,
        expiresAt: resetData.expiresAt
      },
      actions: [
        {
          id: 'reset_password',
          label: 'Reset Password',
          url: resetData.resetUrl
        }
      ]
    };
    
    return this.send(userId, payload, {
      template: 'security',
      subject: 'Password Reset Request - Throne8'
    });
  }
  
  // Send email verification
  async sendEmailVerification(userId, verificationData) {
    const payload = {
      title: 'Verify Your Email Address',
      body: 'Please verify your email address to complete your account setup.',
      type: 'security',
      priority: 'high',
      variables: {
        verificationUrl: verificationData.verificationUrl,
        expiresAt: verificationData.expiresAt
      },
      actions: [
        {
          id: 'verify_email',
          label: 'Verify Email',
          url: verificationData.verificationUrl
        }
      ]
    };
    
    return this.send(userId, payload, {
      template: 'verification',
      subject: 'Verify Your Email - Throne8'
    });
  }
  
  // Send notification digest
  async sendDigest(userId, notifications, frequency = 'daily') {
    const payload = {
      title: `Your ${frequency} notification digest`,
      body: `You have ${notifications.length} new notifications.`,
      type: 'system',
      priority: 'low',
      variables: {
        notifications,
        frequency,
        digestUrl: `${process.env.APP_URL}/notifications`
      },
      actions: [
        {
          id: 'view_all',
          label: 'View All Notifications',
          url: `${process.env.APP_URL}/notifications`
        }
      ]
    };
    
    return this.send(userId, payload, {
      template: 'digest',
      subject: `Your ${frequency} digest - Throne8`
    });
  }
}

// Export enhanced service instance
const enhancedEmailService = new EnhancedEmailService();

// Export both the enhanced service and event emitter
export default enhancedEmailService;
// export { emailEvents };

// Export individual methods for direct use
export const send = (userId, payload, options) => enhancedEmailService.send(userId, payload, options);
export const sendBulk = (emailList, options) => enhancedEmailService.sendBulk(emailList, options);
export const sendTransactional = (userId, template, data, options) => enhancedEmailService.sendTransactional(userId, template, data, options);
export const sendWelcomeEmail = (userId, userData) => enhancedEmailService.sendWelcomeEmail(userId, userData);
export const sendPasswordReset = (userId, resetData) => enhancedEmailService.sendPasswordReset(userId, resetData);
export const sendEmailVerification = (userId, verificationData) => enhancedEmailService.sendEmailVerification(userId, verificationData);
export const sendDigest = (userId, notifications, frequency) => enhancedEmailService.sendDigest(userId, notifications, frequency);
export const testEmail = (email) => enhancedEmailService.testEmail(email);
export const getHealthStatus = () => enhancedEmailService.getHealthStatus();
export const handleDeliveryWebhook = (provider, payload) => enhancedEmailService.handleDeliveryWebhook(provider, payload);