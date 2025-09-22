// JavaScript Document

 // EXAMPLE
 var one = 1;
 var two = 2;

 function add(x, y) {
  return x + y;
 }

 var out = add(one, two);

 // Enhanced functionality for the website
 document.addEventListener('DOMContentLoaded', function() {
  
  // Smooth scrolling for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
   anchor.addEventListener('click', function (e) {
    e.preventDefault();
    const target = document.querySelector(this.getAttribute('href'));
    if (target) {
     target.scrollIntoView({
      behavior: 'smooth'
     });
    }
   });
  });

  // Active navigation highlighting
  const currentPath = window.location.pathname;
  const navLinks = document.querySelectorAll('nav a');
  navLinks.forEach(link => {
   if (link.getAttribute('href') === currentPath || 
       (currentPath.includes(link.getAttribute('href').replace('/', '')) && link.getAttribute('href') !== '/')) {
    link.style.backgroundColor = '#ffffffff';
    link.style.color = "black";
    link.style.borderRadius = '3px';
   }
  });

  // Gallery functionality
  if (document.querySelector('.gallery-grid')) {
   const galleryItems = document.querySelectorAll('.gallery-item');
   galleryItems.forEach((item, index) => {
    item.addEventListener('click', function() {
     // Remove expanded class from all items
     galleryItems.forEach(otherItem => {
      if (otherItem !== this) {
       otherItem.classList.remove('expanded');
      }
     });
     // Toggle expanded class on clicked item
     this.classList.toggle('expanded');
    });

    // Add keyboard support for accessibility
    item.setAttribute('tabindex', '0');
    item.addEventListener('keypress', function(e) {
     if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.click();
     }
    });
   });
  }

  // Blog read more functionality
  if (document.querySelector('.blog-post')) {
   const readMoreLinks = document.querySelectorAll('.read-more');
   readMoreLinks.forEach(link => {
    link.addEventListener('click', function(e) {
     e.preventDefault();
     const post = this.closest('.blog-post');
     const fullText = post.querySelector('.full-text');
     
     if (fullText) {
      fullText.style.display = fullText.style.display === 'none' ? 'block' : 'none';
      this.textContent = fullText.style.display === 'none' ? 'Read More' : 'Read Less';
     } else {
      // Simulate expanding content
      alert('This would normally expand to show the full blog post content.');
     }
    });
   });
  }

  // Contact form enhancements
  if (document.getElementById('contactForm')) {
   const form = document.getElementById('contactForm');
   const inputs = form.querySelectorAll('input, select, textarea');
   
   // Add real-time validation feedback
   inputs.forEach(input => {
    input.addEventListener('blur', function() {
     validateField(this);
    });
    
    input.addEventListener('input', function() {
     if (this.classList.contains('error')) {
      validateField(this);
     }
    });
   });
   
   function validateField(field) {
    const value = field.value.trim();
    let isValid = true;
    
    // Remove existing error styling
    field.classList.remove('error');
    const existingError = field.parentNode.querySelector('.error-message');
    if (existingError) {
     existingError.remove();
    }
    
    // Validate based on field type
    if (field.hasAttribute('required') && !value) {
     isValid = false;
     showFieldError(field, 'This field is required');
    } else if (field.type === 'email' && value) {
     const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
     if (!emailRegex.test(value)) {
      isValid = false;
      showFieldError(field, 'Please enter a valid email address');
     }
    } else if (field.type === 'tel' && value) {
     const phoneRegex = /^[\+]?[1-9][\d]{0,15}$/;
     if (!phoneRegex.test(value.replace(/[\s\-\(\)]/g, ''))) {
      showFieldError(field, 'Please enter a valid phone number');
     }
    }
    
    return isValid;
   }
   
   function showFieldError(field, message) {
    field.classList.add('error');
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    errorDiv.style.color = 'red';
    errorDiv.style.fontSize = '0.8em';
    errorDiv.style.marginTop = '5px';
    field.parentNode.appendChild(errorDiv);
   }
  }

  // Add some interactive effects
  const buttons = document.querySelectorAll('button');
  buttons.forEach(button => {
   button.addEventListener('mouseenter', function() {
    this.style.transform = 'translateY(-2px)';
    this.style.boxShadow = '0 4px 8px rgba(0,0,0,0.2)';
   });
   
   button.addEventListener('mouseleave', function() {
    this.style.transform = 'translateY(0)';
    this.style.boxShadow = 'none';
   });
  });

  // Add fade-in animation for main content
  const main = document.querySelector('main');
  if (main) {
   main.style.opacity = '0';
   main.style.transform = 'translateY(20px)';
   main.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
   
   setTimeout(() => {
    main.style.opacity = '1';
    main.style.transform = 'translateY(0)';
   }, 100);
  }
 });